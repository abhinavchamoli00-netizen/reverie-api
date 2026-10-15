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

  // ============================================
  // DIAGNOSTIC — list all available models
  // ============================================
  if (body.mode === 'diagnostic') {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${GROQ_KEY}` }
      });
      const data = await r.json();
      if (!r.ok) {
        return res.status(500).json({ error: 'Groq auth failed', details: data });
      }
      const modelIds = (data.data || []).map((m) => m.id).sort();
      return res.status(200).json({ success: true, models: modelIds });
    } catch (e) {
      return res.status(500).json({ error: 'Fetch failed', details: e.message });
    }
  }

  // ============================================
  // NORMAL MODES
  // ============================================
  const mode = body.mode || 'prompt';

  let systemPrompt = '';
  let userPrompt = '';

  if (mode === 'prompt') {
    const recentMoods = body.recentMoods || [];
    const recentPrompts = body.recentPrompts || [];

    systemPrompt = `You are a thoughtful journaling companion for an app called REVERIE. Generate a single, unique, reflective journaling prompt.

Rules:
- Output ONLY the prompt — no quotes, no explanation, no preamble
- 1 sentence, max 15 words
- Warm, gentle, personal tone
- Avoid clichés like "How was your day"
- Vary topics: gratitude, memories, relationships, self-discovery, small moments, future hopes, challenges, joy
- Never repeat a prompt from the recent list`;

    userPrompt = `Generate one new journaling prompt.`;
    if (recentMoods.length > 0) {
      userPrompt += ` Recent user moods (0=great, 4=sad): ${recentMoods.join(', ')}.`;
    }
    if (recentPrompts.length > 0) {
      userPrompt += ` Avoid these:\n- ${recentPrompts.slice(0, 8).join('\n- ')}`;
    }
  } else if (mode === 'reflection') {
    const entryText = (body.entryText || '').substring(0, 500);
    const mood = body.mood;
    const moodLabel =
      mood !== null && mood !== undefined
        ? ['Great', 'Good', 'Okay', 'Low', 'Sad'][mood]
        : 'not specified';

    systemPrompt = `You are REVERIE — a warm, gentle journaling companion. The user just wrote a journal entry. Reflect back what you notice in a supportive, human way.

Rules:
- Output ONLY the reflection — no greeting, no "I", no preamble
- 2-3 sentences, max 45 words
- Warm, non-judgmental tone
- Notice the emotion, pattern, or something worth celebrating
- End with ONE gentle follow-up question
- Use "you" — speak directly to the writer`;

    userPrompt = `Mood: ${moodLabel}\n\nEntry: "${entryText}"\n\nGive a warm, brief reflection.`;
  } else {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  // Try multiple models, collect all errors
  const MODELS = [
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-120b',
  ];

  const attempts = [];

  for (const model of MODELS) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: mode === 'prompt' ? 1.1 : 0.75,
          max_tokens: mode === 'prompt' ? 80 : 200,
        }),
      });

      const data = await groqRes.json();

      if (!groqRes.ok) {
        attempts.push({
          model,
          status: groqRes.status,
          error: data.error?.message || 'Unknown error',
        });
        continue;
      }

      let reply = data.choices?.[0]?.message?.content?.trim() || '';

      // Reasoning models put output here
      if (!reply && data.choices?.[0]?.message?.reasoning) {
        reply = data.choices[0].message.reasoning.trim();
      }

      const cleaned = reply
        .replace(/^["'""'']|["'""'']$/g, '')
        .replace(/^Output:\s*/i, '')
        .replace(/^Reflection:\s*/i, '')
        .replace(/^Prompt:\s*/i, '')
        .replace(/^Sure,?\s*/i, '')
        .trim();

      if (cleaned) {
        return res.status(200).json({ success: true, text: cleaned, model });
      }

      attempts.push({ model, status: 200, error: 'Empty response' });
    } catch (e) {
      attempts.push({ model, error: e.message });
    }
  }

  return res.status(500).json({ error: 'All models failed', attempts });
}