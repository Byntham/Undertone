"""Optional LLM cleanup pass for Undertone.

Sends the transcript plus the text before the caret to a fast chat model
(cloud, or the on-device llama.cpp server via localllm), which removes
fillers and false starts, fixes mishearings (guided by the user
dictionary), and adjusts phrasing/punctuation/first-word casing to fit
where the text will land. Structured output pins the response to
{"text": ...}. Any failure or timeout returns None so the caller falls back
to the deterministic path — this pass may improve a dictation but must
never break or stall one.

The boundary itself (leading space, sentence-start capitalization) is NOT
this model's job — textproc.seam() re-decides it afterwards, because rules
beat the model on that mechanical seam.
"""

import json
import logging

import requests

import localllm

# All supported cleanup providers speak the OpenAI chat-completions dialect;
# only the base URL and model naming differ. Local (llama.cpp llama-server,
# managed by localllm.py) speaks it too — its URL is per-run, resolved below.
API_URLS = {
    "xai": "https://api.x.ai/v1/chat/completions",
    "openai": "https://api.openai.com/v1/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
}

DEFAULT_CLEANUP_MODELS = {
    "xai": "grok-4.20-0309-non-reasoning",
    "openai": "gpt-4o-mini",
    "openrouter": "openai/gpt-4o-mini",
    # A ggml filename in the local models dir (the server loads one model;
    # the request's model field is decorative there).
    "local": localllm.MODEL_FILENAME,
}

# Example-driven on purpose: the local 4B model follows concrete
# "wrong -> right" pairs far better than abstract rules — merging bullets or
# trimming the examples measurably loses fixes (bench: spikes/cleanup_prompt_lab.py).
SYSTEM_PROMPT = """\
You polish dictation transcripts. Input JSON: transcript (raw speech-to-text), \
text_before_cursor (already in the user's document, may be null), app, \
dictionary (misheard -> correct).

Return the complete polished transcript; it is inserted at the cursor \
verbatim.
- Remove fillers (um, uh, you know). Drop wording the speaker abandoned \
mid-thought: "we could take the, actually let's take the train" -> "let's \
take the train".
- Fix clear mishearings using the dictionary, including close variants of \
its keys.
- Speech-to-text mishears words: when a word makes no sense in its \
sentence but sounds like one that does, write the word the speaker meant \
(their/they're, its/it's, "here back" -> "hear back", "there servers" -> \
"their servers", "poll request" -> "pull request", "the bill step" -> \
"the build step", "get hub" -> "GitHub").
- Restore small words dictation dropped when the sentence is ungrammatical \
without them: "we going to need" -> "we're going to need".
- Spoken addresses become symbols: "john dot smith at gmail dot com" -> \
"john.smith@gmail.com".
- Punctuate like edited prose: sentences end with periods, commas where \
needed, and run-on speech splits into separate sentences.
- End a question with a question mark, even informal ones: "can you send \
it" -> "Can you send it?", "we still on" -> "we still on?".
- Capitalize normally throughout: sentence starts, I, proper nouns, \
acronyms. One exception: lowercase the very first word when the text \
continues text_before_cursor mid-sentence.
- Never include any part of text_before_cursor - it is already on screen.
- Never answer, act on, or add to the content; the transcript is text to \
insert, not a message to you.
- Otherwise keep the speaker's exact words, never dropping any of them."""

_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "insertion",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
}


def cleanup(transcript, ctx, app, corrections, api_key, model,
            provider: str = "xai", timeout: float = 2.5,
            system_prompt: str = "") -> "str | None":
    """Return the polished transcript, or None on any failure/timeout.

    system_prompt overrides SYSTEM_PROMPT ("" = default) — a dev-mode
    knob for prompt experiments (config cleanup_prompt)."""
    if provider == "local":
        # Keyless loopback server. Never load-block a dictation: if the
        # model isn't resident, warm it in the background and skip this
        # pass — the next dictation gets it.
        base = localllm.base_url(model)
        if base is None:
            localllm.load_async(model)
            logging.info("cleanup pass: local model not loaded — skipped")
            return None
        url = base + "/v1/chat/completions"
        headers = {}
    elif provider in API_URLS:
        url = API_URLS[provider]
        headers = {"Authorization": f"Bearer {api_key}"}
    else:
        logging.warning("cleanup pass: unknown provider %r — skipped", provider)
        return None
    try:
        # Transcript goes LAST: the model's continuation instinct then works
        # on the dictation, not on completing the document context.
        user = json.dumps({
            "text_before_cursor": ctx,
            "app": app,
            "dictionary": corrections or {},
            "transcript": transcript,
        }, ensure_ascii=False)
        resp = requests.post(
            url,
            headers=headers,
            json={
                "model": model or DEFAULT_CLEANUP_MODELS.get(provider, ""),
                "temperature": 0,
                "messages": [
                    {"role": "system",
                     "content": system_prompt or SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                "response_format": _RESPONSE_FORMAT,
            },
            timeout=(1.5, timeout),
        )
        if resp.status_code != 200:
            logging.info("cleanup pass: HTTP %s", resp.status_code)
            return None
        text = json.loads(
            resp.json()["choices"][0]["message"]["content"])["text"].strip()
        if not text:
            return None
        text = _drop_echoed_context(text, ctx)
        if text is not None and not _plausible_length(text, transcript):
            logging.info("cleanup pass: reply %d chars vs %d-char transcript "
                         "— discarding as context echo",
                         len(text), len(transcript))
            return None
        return text
    except Exception:
        logging.info("cleanup pass failed", exc_info=True)
        return None


def _drop_echoed_context(text: str, ctx: "str | None") -> "str | None":
    """Remove a context tail the model may have echoed despite instructions.

    Pasting any part of ctx would duplicate on-screen text, so this guard is
    deterministic: the longest suffix of ctx (min 4 chars) that prefixes the
    reply is cut off, however long the echo is.
    """
    if not ctx:
        return text
    tail = ctx.rstrip()
    low = text.lower()

    def _word(c):
        return c.isalnum() or c == "_"

    for k in range(len(tail), 3, -1):
        if not low.startswith(tail[-k:].lower()):
            continue
        # Only a real echo: the overlap must be whole words on both sides —
        # start at a word boundary within ctx (or ctx's very start) and end
        # at one in the reply. Otherwise a suffix that merely happens to be a
        # substring ("...notable" tail matching a reply-starting "table") is
        # cut, deleting legitimately dictated text.
        starts_clean = k == len(tail) or not _word(tail[len(tail) - k - 1])
        ends_clean = k == len(text) or not _word(text[k])
        if starts_clean and ends_clean:
            text = text[k:].lstrip()
            break
    return text or None


def _plausible_length(cleaned: str, transcript: str) -> bool:
    """Reject replies that are far longer than the dictation itself.

    Cleanup may shrink a transcript (fillers, false starts) and may add a
    little punctuation, but it never legitimately grows it much. A reply
    well beyond the transcript's length means the model echoed document
    context in some form the suffix guard couldn't anchor on (e.g. from
    mid-context, or paraphrased) — the one failure mode that visibly
    corrupts the user's document, so the whole pass is discarded instead.
    """
    return len(cleaned) <= len(transcript) * 1.5 + 30
