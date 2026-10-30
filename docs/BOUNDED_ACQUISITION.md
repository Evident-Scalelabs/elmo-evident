# Bounded Direct-Model Acquisition

This private admin API acquires one Vercel AI Gateway direct-model answer without starting a worker, scheduling another run, changing brand targets or judging mentions. DataForSEO is not an accepted source. API answers are a separate population from consumer-web answers. A direct API response does not establish a consumer-web observation.

Create a brand and a **disabled** prompt through the existing APIs. Freeze the neutral prompt, IDs, exact requested model slug, grounding choice, output cap and deployed revision. The pinned slug is a request identity, not a guarantee that a provider alias always serves immutable weights. Locale is unsupported and remains null. Set the producer revision using `RAILWAY_GIT_COMMIT_SHA`, or `ELMO_ACQUISITION_SOURCE_REVISION` for a source-built deployment. Apply the additive acquisition migration before enabling the endpoint. Use `DEPLOYMENT_MODE=local`, an explicit `APP_URL`, the isolated database, stable auth/encryption secrets and instance admin bearer key. Provider credentials remain backend-only.

`POST /api/v1/acquisitions` requires an instance admin bearer key:

```json
{
  "schemaVersion": "elmo.acquisition.request.v1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "expectedProducerRevision": "<40-character deployed Git revision>",
  "promptId": "00000000-0000-4000-8000-000000000002",
  "brandId": "example-brand",
  "prompt": "Which example suppliers offer reusable packaging?",
  "target": {
    "provider": "ai-gateway",
    "model": "openai/gpt-4.1",
    "access": "api",
    "surface": "direct_model_api",
    "webSearch": true,
    "grounding": "native",
    "maxOutputTokens": 2048,
    "locale": null
  },
  "deadlineAt": "<future ISO UTC deadline>"
}
```

The model above is an example, not a default or quality recommendation. The caller selects an explicit provider/model slug and supplies current pricing evidence. Auto/latest aliases and routing suffixes are refused. `webSearch` must agree with `grounding`: true/native or false/none. Output is capped at the selected 1–8192 tokens. Exactly one user message is sent, without a client-name persona or appended judge instruction.

The caller must admit the request under its existing reservation, dispatch cap and deadline. No provider call is authorized before a fresh capped key is verified. This endpoint supplies no second monetary ledger. It reserves the immutable UUID and SHA-256 of recursively key-sorted JSON in `acquisition_requests` before dispatch. Concurrent/repeated IDs return existing state; changed requests under the same ID return 409. Expired new work is refused, but existing requests remain readable.

Each admitted acquisition makes one inference POST using the unchanged configured model. Ungrounded requests use Gateway Chat Completions; native search uses OpenAI Responses, Anthropic Messages, the installed SDK's Google/xAI tool protocol, or a Perplexity search model. There are no old-provider plugins, model suffix substitutions, generic-search fallbacks or automatic retries. Unsupported native protocols and absent exact catalog models fail before purchase admission. The caller's absolute deadline bounds waiting to at most 120 seconds; cancellation cannot prove that remote billing stopped. Charged tool costs and native grounding still require account acceptance.

`GET /api/v1/acquisitions/{requestId}` reads the append-only raw run directly, without joins to extraction/mention judgments. It returns the frozen request/hash and original producer revision. `servedModel` comes only from the provider payload; absent is null. `effectiveTarget` echoes requested controls separately from observations: `grounded=true` requires provider URL citations, otherwise null; `groundingSource` is `provider_url_citations` or `unreported`; `localeSource` is `not_controlled`. A requested native-search tool alone never proves search ran.

- `dispatching`: identity reserved, no retained response yet.
- `completed`: HTTP response retained, including non-2xx or non-JSON errors. Inspect `providerHttpStatus`, raw body and answer status; this is not scoring success.
- `unknown_after_dispatch`: no reliable retained completion, including an interrupted HTTP response. Addressed reads never repurchase; there is no proven remote recovery operation for a lost synchronous completion.
- `retention_failed`: HTTP response arrived but local raw persistence failed. The reply includes the envelope and `retained=false` for the caller's archive; subsequent reads retain the unknown gap.

`run.rawOutput` is `elmo.provider_http.v1`: URL, method, status, response headers, body base64, SHA-256 and byte length. These are original content-decoded HTTP entity bytes, not compressed wire bytes. Routing/model/usage/error fields remain in those bytes. Derived text/citations are returned separately. The envelope is intended for this raw acquisition endpoint; do not send these runs into the recurring worker or assume stock dashboards understand it. No BotSee audits, factor grades or Findings are synthesized.

Focused transport fixtures cover exact controls/body retention, non-JSON errors, no tools, cancellation and no retry. Database fixture sources cover concurrent reservation/replay, unknown outcomes, direct raw reads, scope refusal and raw-write failure. Run native disposable database tests once at integration; full builds run remotely on Railway. This contract has no paid acceptance result.

References: [Gateway native web search](https://vercel.com/docs/ai-gateway/models-and-providers/web-search) and the [public model catalog](https://ai-gateway.vercel.sh/v1/models). Current availability and pricing must be checked for the exact selected model.


Gateway source preparation uses provider `ai-gateway`. The exact native protocol is selected without changing the configured model: OpenAI Responses, Anthropic Messages, installed SDK native Google/xAI tools, or Perplexity's model-native search. Public model metadata is checked before new purchase admission; an absent exact model never selects a substitute. The admitted acquisition retains exactly one physical inference response, including non-JSON/non-2xx bytes, status and SHA256. Historical requests/envelopes retain their original provider and remain GET-readable without redispatch. Keys, current model availability, native grounding and observed cost remain activation gates.
