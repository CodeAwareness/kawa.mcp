/**
 * Reject a tool call that is missing a required argument, at the one seam every
 * tool already passes through.
 *
 * WHY THIS EXISTS. `get_relevant_context` was called with `task` instead of
 * `prompt`. `prompt` has always been declared required — plain `z.string()`,
 * and `isRequired()` puts it in the `required` array we advertise — but nothing
 * checked incoming arguments. The dispatcher passes `args as any` straight to
 * each handler, so `input.prompt` was `undefined`, the tool forwarded
 * `query: undefined`, JSON dropped the key, and Muninn answered
 * `missing field 'query'`.
 *
 * `query` is not a parameter of that tool. It is the internal IPC field name
 * `prompt` maps onto, so the error named something the caller could not act on,
 * and it was misdiagnosed as a Muninn outage twice before anyone read the
 * schema.
 *
 * The worse half was the shape of the failure, not the wording. The handler
 * caught it and returned a WELL-FORMED EMPTY RESULT — no intents, no decisions,
 * `totalIntentsSearched: 0` — with `error` tucked into a field nothing
 * surfaces. A broken call looked exactly like "nothing relevant found", which
 * is a plausible answer, so two sessions ran with no recall at all and nothing
 * appeared wrong.
 *
 * DELIBERATELY NOT a full `.parse()`. Several tools declare `.default()` values
 * that Muninn currently supplies; parsing would start applying them here
 * instead, changing behaviour nobody asked to change. The failure was a missing
 * field, not a malformed one, so presence is the whole check.
 */

/** A Zod type is required unless it is optional or carries a default. */
function isRequiredType(zodType: unknown): boolean {
  const typeName = (zodType as any)?._def?.typeName
  return typeName !== 'ZodOptional' && typeName !== 'ZodDefault'
}

/**
 * The required keys of a tool's schema, in declaration order.
 *
 * Mirrors the `required` array sent in `tools/list`, so what is advertised and
 * what is enforced cannot disagree.
 */
export function requiredKeys(shape: Record<string, unknown>): string[] {
  return Object.entries(shape)
    .filter(([, value]) => isRequiredType(value))
    .map(([key]) => key)
}

/**
 * Which required arguments are absent.
 *
 * `null` and `undefined` count as missing; every other value is the handler's
 * business. An empty string is NOT treated as missing — that is a malformed
 * value rather than an absent field, and this check deliberately stops at
 * presence.
 */
export function missingRequiredArgs(
  shape: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
): string[] {
  const provided = args ?? {}
  return requiredKeys(shape).filter(key => provided[key] === undefined || provided[key] === null)
}

/**
 * Operator-readable refusal naming what to re-send.
 *
 * It lists the keys that WERE received, because the original failure was a
 * near-miss on a name: seeing `task` beside "missing: prompt" identifies the
 * mistake immediately, where the parameter name alone did not.
 */
export function describeMissingArgs(
  name: string,
  missing: readonly string[],
  args: Record<string, unknown> | undefined,
): string {
  const received = Object.keys(args ?? {})
  const receivedText = received.length > 0 ? received.join(', ') : '(none)'
  const plural = missing.length === 1 ? 'parameter' : 'parameters'
  return (
    `${name}: missing required ${plural} ${missing.map(m => `"${m}"`).join(', ')}. ` +
    `Received: ${receivedText}. Nothing was sent. ` +
    `Re-send the call with the named ${plural} included.`
  )
}
