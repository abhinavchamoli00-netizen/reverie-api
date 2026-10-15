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
  const recentMoods = body.recentMoods || [];
  const recentPrompts = body.recentPrompts || [];

  let systemPrompt = '';
  let userPrompt = '';

  if (mode === 'prompt') {
    systemPrompt = `You are a thoughtful journaling companion for an app called REVERIE. Your job is to generate a single, unique, reflective journaling prompt.

Rules:
- Output ONLY the prompt — no quotes, no explanation, no preamble
- 1 sentence, max 15 words
- Warm, gentle, personal tone
- Avoid clichés like "How was your day"
- Vary topics: gratitude, memories, relationships, self-discovery, small moments, future hopes, challenges, joy
- If recent moods are mostly negative, be gentler and more supportive
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
    systemPrompt = `You are REVERIE — a warm, gentle journaling companion. The user just wrote a journal entry. Reflect back what you notice in a supportive way.

Rules:
- Output ONLY the reflection text — no greeting, no "I", keep it short (2-3 sentences)
- Warm, non-judgmental tone
- Notice emotions, patterns, or things worth celebrating
- Ask one gentle follow-up question at the end
- Never diagnose, never give medical advice
- 40 words max`;

    userPrompt = `User entry: "${entryText}"${mood !== undefined && mood !== null ? `\nMood: ${['Great', 'Good', 'Okay', 'Low', 'Sad'][mood]}` : ''}`;
  } else {
    return res.status(400).json({ error: 'Invalid mode' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: mode === 'prompt' ? 1.1 : 0.7,
        max_tokens: mode === 'prompt' ? 50 : 120
      })
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      return res.status(500).json({ error: 'AI error', details: data });
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || '';

    // Clean up quotes/punctuation
    const cleaned = reply.replace(/^["'""'']|["'""'']$/g, '').trim();

    return res.status(200).json({ success: true, text: cleaned });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', details: e.message });
  }
}