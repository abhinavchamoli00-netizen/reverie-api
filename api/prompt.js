export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'Config missing' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const mode = body.mode || 'prompt';

  // ============================================
  // TRANSCRIBE MODE — Groq Whisper
  // ============================================
  if (mode === 'transcribe') {
    const audioBase64 = body.audioBase64;
    if (!audioBase64) {
      return res.status(400).json({ error: 'Missing audio data' });
    }

    try {
      // Convert base64 to buffer
      const buffer = Buffer.from(audioBase64, 'base64');

      // Build multipart form data for Groq
      const boundary = '----ReverieBoundary' + Date.now();
      const filename = 'audio.m4a';

      const parts = [];

      // file part
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/m4a\r\n\r\n`
      );
      const fileHeader = Buffer.from(parts.join(''), 'utf8');
      const fileFooter = Buffer.from('\r\n', 'utf8');

      // model part
      const modelPart = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`,
        'utf8'
      );

      // language hint
      const langPart = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`,
        'utf8'
      );

      const closing = Buffer.from(`--${boundary}--\r\n`, 'utf8');

      const finalBody = Buffer.concat([
        fileHeader,
        buffer,
        fileFooter,
        modelPart,
        langPart,
        closing,
      ]);

      const groqRes = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GROQ_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: finalBody,
        }
      );

      const data = await groqRes.json();

      if (!groqRes.ok) {
        return res.status(500).json({
          error: 'Transcription failed',
          details: data,
        });
      }

      const text = (data.text || '').trim();
      return res.status(200).json({ success: true, text });
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'Server error', details: e.message });
    }
  }

  // ============================================
  // PROMPT / REFLECTION MODES
  // ============================================
  let systemPrompt = '';
  let userPrompt = '';

  if (mode === 'prompt') {
    const recentMoods = body.recentMoods || [];
    const recentPrompts = body.recentPrompts || [];

    systemPrompt = `You are a thoughtful journaling companion for REVERIE. Generate one unique reflective journaling prompt.

Rules:
- Reply with ONLY the prompt — no quotes, no prefix
- 1 sentence, max 15 words
- Warm, gentle, personal tone
- Avoid clichés like "How was your day"
- Vary topics: gratitude, memories, relationships, self-discovery, small moments, future hopes, challenges
- Never repeat a prompt from the recent list`;

    userPrompt = `Write one new prompt.`;
    if (recentMoods.length > 0) {
      userPrompt += ` Recent moods (0=great, 4=sad): ${recentMoods.join(', ')}.`;
    }
    if (recentPrompts.length > 0) {
      userPrompt += ` Do not repeat these:\n- ${recentPrompts
        .slice(0, 8)
        .join('\n- ')}`;
    }
  } else if (mode === 'reflection') {
    const entryText = (body.entryText || '').substring(0, 500);
    const mood = body.mood;
    const moodLabel =
      mood !== null && mood !== undefined
        ? ['Great', 'Good', 'Okay', 'Low', 'Sad'][mood]
        : 'not specified';

    systemPrompt = `You are REVERIE — a warm journaling companion. The user just wrote an entry. Reflect back what you notice with warmth.

Rules:
- Reply with ONLY the reflection — no greeting, no "I", no prefix
- 2 sentences, max 40 words
- Warm, encouraging, non-judgmental
- Notice the emotion or something worth celebrating
- End with one gentle follow-up question
- Speak directly to the writer using "you"`;

    userPrompt = `Mood: ${moodLabel}\n\nEntry: "${entryText}"\n\nWrite the reflection.`;
  } else {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const MODELS = [
    { id: 'openai/gpt-oss-20b', reasoning: true },
    { id: 'openai/gpt-oss-120b', reasoning: true },
    { id: 'qwen/qwen3.8-27b', reasoning: false },
    { id: 'allam-2-7b', reasoning: false },
  ];

  const attempts = [];

  for (const m of MODELS) {
    try {
      const reqBody = {
        model: m.id,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: mode === 'prompt' ? 1.0 : 0.7,
        max_tokens: 600,
      };

      if (m.reasoning) {
        reqBody.reasoning_effort = 'low';
      }

      const groqRes = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_KEY}`,
          },
          body: JSON.stringify(reqBody),
        }
      );

      const data = await groqRes.json();

      if (!groqRes.ok) {
        attempts.push({
          model: m.id,
          status: groqRes.status,
          error: data.error?.message || 'Unknown',
        });
        continue;
      }

      let reply = data.choices?.[0]?.message?.content?.trim() || '';

      if (!reply && data.choices?.[0]?.message?.reasoning) {
        const r = data.choices[0].message.reasoning;
        const sentences = r
          .split(/[.!?]\s+/)
          .filter((s) => s.trim().length > 10);
        if (sentences.length > 0) {
          reply = sentences[sentences.length - 1].trim();
          if (!/[.!?]$/.test(reply)) reply += '?';
        }
      }

      const cleaned = reply
        .replace(/^["'""'']|["'""'']$/g, '')
        .replace(/^\*+\s*/, '')
        .replace(/^Output:\s*/i, '')
        .replace(/^Reflection:\s*/i, '')
        .replace(/^Prompt:\s*/i, '')
        .replace(/^Sure,?\s*/i, '')
        .replace(/^(Here is|Here's)\s+.*?:\s*/i, '')
        .replace(/\*\*/g, '')
        .trim();

      if (cleaned && cleaned.length > 5) {
        return res.status(200).json({
          success: true,
          text: cleaned,
          model: m.id,
        });
      }

      attempts.push({
        model: m.id,
        status: 200,
        error: 'Empty after cleaning',
      });
    } catch (e) {
      attempts.push({ model: m.id, error: e.message });
    }
  }

  return res.status(500).json({ error: 'All models failed', attempts });
}