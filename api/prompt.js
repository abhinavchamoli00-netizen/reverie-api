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

  let systemPrompt = '';
  let userPrompt = '';

  if (mode === 'prompt') {
    const recentMoods = body.recentMoods || [];
    const recentPrompts = body.recentPrompts || [];

    systemPrompt = `You are a thoughtful journaling companion for an app called REVERIE. Generate a single, unique, reflective journaling prompt.

Rules:
- Output ONLY the prompt — no quotes, no explanation, no preamble, no "Output:" prefix
- 1 sentence, max 15 words
- Warm, gentle, personal tone
- Avoid clichés like "How was your day"
- Vary topics: gratitude, memories, relationships, self-discovery, small moments, future hopes, challenges, joy
- If recent moods are mostly negative, be gentler and supportive
- Never repeat a prompt from the recent list`;

    userPrompt = `Generate one new journaling prompt.`;
    if (recentMoods.length > 0) {
      userPrompt += ` Recent user moods (0=great, 4=sad): ${recentMoods.join(', ')}.`;
    }
    if (recentPrompts.length > 0) {
      userPrompt += ` Avoid these recent prompts:\n- ${recentPrompts.slice(0, 8).join('\n- ')}`;
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
- Output ONLY the reflection — no greeting, no "I", no preamble, no "Output:" prefix
- 2-3 sentences, max 45 words
- Warm, non-judgmental, encouraging tone
- Notice the emotion, a pattern, or something worth celebrating
- End with ONE gentle follow-up question
- Never diagnose, never give medical advice
- Use "you" — speak directly to the writer`;

    userPrompt = `Mood: ${moodLabel}\n\nEntry: "${entryText}"\n\nGive a warm, brief reflection.`;
  } else {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  const MODELS = [
    'llama-3.1-8b-instant',
    'llama3-70b-8192',
    'qwen/qwen3-32b',
  ];

  let lastError = null;

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
        lastError = data;
        continue;
      }

      let reply = data.choices?.[0]?.message?.content?.trim() || '';

      // Some reasoning models put output in "reasoning" field
      if (!reply && data.choices?.[0]?.message?.reasoning) {
        reply = data.choices[0].message.reasoning.trim();
      }

      // Clean up quotes and strip common prefixes
      const cleaned = reply
        .replace(/^["'""'']|["'""'']$/g, '')
        .replace(/^Output:\s*/i, '')
        .replace(/^Reflection:\s*/i, '')
        .replace(/^Prompt:\s*/i, '')
        .replace(/^Sure,?\s*/i, '')
        .replace(/^Here's\s+(a|your)\s+.*?:\s*/i, '')
        .trim();

      if (cleaned) {
        return res.status(200).json({ success: true, text: cleaned, model });
      }

      lastError = { reason: 'Empty response', model };
    } catch (e) {
      lastError = { reason: e.message, model };
    }
  }

  return res.status(500).json({ error: 'All models failed', details: lastError });
}