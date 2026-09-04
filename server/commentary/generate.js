/* Generates the natural-language match recap from a digest.
 *
 * summarize.js has already turned the stored stats blob into a few lines of
 * plain text, so this module's only job is prompting and the API call.
 *
 * Deliberately a single stateless request — no tools, no conversation. The
 * prompt is a fixed system prompt plus one digest, which is exactly the shape
 * prompt caching likes: the system prompt is identical on every match, so it
 * is marked cacheable and only the (short) digest is billed at full rate.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// A 3-sentence recap from a pre-digested summary is an easy writing task, so
// this defaults to the cheapest model rather than the smartest: Haiku 4.5 is
// ~5x cheaper than Opus 5 ($1/$5 vs $5/$25 per Mtok). Override with
// PP_RECAP_MODEL to trade cost for polish.
const MODEL = process.env.PP_RECAP_MODEL || 'claude-haiku-4-5';

// `output_config.effort` is a 4.6-and-later parameter — older models such as
// Haiku 4.5 return a 400 if it's sent. Only include it for models that take
// it, so switching PP_RECAP_MODEL either way can't produce a broken request.
const EFFORT_MODELS = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5',
];
const SUPPORTS_EFFORT = EFFORT_MODELS.includes(MODEL);

// Kept byte-identical across every request so the cached prefix actually hits.
const SYSTEM_PROMPT = `You are a pool commentator writing a short recap of a finished pool match.

You are given a factual digest of one game: the rule set being played, the
players, the result, per-player totals, and a shot-by-shot list. The rule set is
either 8-ball or 9-ball — read it off the digest and never assume; in 9-ball the
8 is an ordinary ball and the 9 is the one that wins.

Write 2-4 sentences of natural commentary:
- Name the winner and how the game was actually decided.
- Call out the one or two moments that mattered most — a long run of pots, a
  costly scratch, a comeback, a game that was scrappy on both sides.
- Use the players' names. Address neither player as "you". A name says nothing
  about a player's gender, so never guess one — use "they" if you need a pronoun.
- Be specific and grounded in the digest. Never invent shots, balls, pockets,
  or drama that the digest does not support.
- Plain prose. No headings, no bullet points, no markdown, no preamble like
  "Here's the recap".

If the digest is thin (very few strokes, missing stats), keep it to one or two
plain sentences rather than padding it out.`;

/**
 * @param {string} digest - output of summarize()
 * @returns {Promise<string>} the recap text
 */
async function generate(digest) {
  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile

  const response = await client.messages.create(Object.assign({
    model: MODEL,
    max_tokens: 1000,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: digest }],
    // A recap is short and well-specified, so on a model that supports effort
    // the lowest setting is plenty — and keeps cost and latency down.
  }, SUPPORTS_EFFORT ? { output_config: { effort: 'low' } } : {}));

  if (response.stop_reason === 'refusal') {
    throw new Error('Commentary request was declined by the safety classifier.');
  }
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Model returned no commentary text.');
  return text;
}

module.exports = { generate, MODEL };
