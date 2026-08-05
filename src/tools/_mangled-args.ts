/**
 * Handling for tool-call args mangled by a mis-closed parameter tag.
 *
 * When an LLM emits a parameter block that is opened correctly but closed with
 * `</fieldName>` instead of the required closing tag — and the NEXT parameter is
 * opened without the required prefix — the harness's tool-call parser never sees
 * a parameter boundary. Everything up to the next well-formed close is folded
 * into the preceding field's string value. What reaches this process is
 * perfectly valid JSON in which one field carries a self-describing tail:
 *
 *   { consequences: 'real text</consequences>\n<parameter name="symptom">real symptom' }
 *
 * Still live: reproduced end-to-end on 2026-08-04, and it fired twice in the
 * session that reworked this module. It is model-side and provider-universal, so
 * no amount of prompt discipline retires it.
 *
 * TWO OUTCOMES, deliberately split:
 *
 *  - ONE absorbed field. Losslessly recoverable — the tail names its field and
 *    carries that field's value verbatim, with nothing left over. Repaired here.
 *    This is a compensating path, which the project otherwise forbids; it is
 *    accepted because the alternative is silent corruption of records that
 *    become immutable on sync, and because the recovery is mechanical rather
 *    than inferred.
 *
 *  - A CHAIN (the absorbed value itself carries further markup). Recovering it
 *    means deciding where one value ends and the next begins across forms that
 *    vary — inner parameters closed correctly, emissions cut off mid-tag,
 *    trailing block closers. That is reconstruction, not recovery, so it is
 *    refused instead: the caller rejects the tool call and the model re-emits.
 *
 * Every outcome is logged by the caller. Nothing here is silent.
 */

/** `</host>` + optional whitespace + a parameter opening + everything after it. */
const MANGLED_TAIL = /<\/([A-Za-z_][\w-]*)>\s*<parameter name="([A-Za-z_]\w*)">([\s\S]*)$/

/**
 * Any residue in a recovered value means the emission carried more than one
 * absorbed field — a further parameter, its own closing tag, or an opening cut
 * off mid-tag.
 */
const RESIDUAL_MARKUP = /<parameter name="|<\/[A-Za-z_][\w-]*>|<[A-Za-z]*$/

export interface SalvageEntry {
  /** The field whose value was recovered. */
  field: string
  /** The field that had absorbed it. */
  fromField: string
}

export interface ChainedEntry {
  /** The field whose string absorbed the rest of the emission. */
  field: string
  /** The first field named in the tail. */
  absorbed: string
}

export interface MangledArgsResult {
  /** `args` with every single-field absorption undone. Never partially chained. */
  args: Record<string, unknown>
  /** Recoveries applied. */
  salvaged: SalvageEntry[]
  /** Chains found. Non-empty means the caller must refuse the tool call. */
  chained: ChainedEntry[]
}

/**
 * Arrays and objects arrive as JSON text; anything else is a plain string.
 * Only attempt a parse when the value actually looks structured, so a string
 * like "123" or "true" is never silently coerced to another type.
 */
function parseSalvagedValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not valid JSON after all — keep the text rather than dropping it.
    }
  }
  return trimmed
}

/**
 * Undo single-field absorptions in `args` and report chains. Returns a new
 * object; `args` is untouched.
 *
 * `knownFields` are the schema field names of the tool being called — neither
 * recovery nor refusal is triggered by a tail naming anything outside that set.
 */
export function resolveMangledArgs(
  args: Record<string, unknown>,
  knownFields: readonly string[],
): MangledArgsResult {
  const known = new Set(knownFields)
  const out: Record<string, unknown> = { ...args }
  const salvaged: SalvageEntry[] = []
  const chained: ChainedEntry[] = []

  for (const [hostField, hostValue] of Object.entries(args)) {
    if (typeof hostValue !== 'string') continue

    const match = hostValue.match(MANGLED_TAIL)
    if (!match || match.index === undefined) continue

    const [, closingTag, targetField, rawValue] = match

    // Three guards, all required. Any miss means this is probably genuine prose
    // (a decision *documenting* this very bug legitimately contains these
    // markers — two such records exist in prod), so leave it alone and let
    // normal validation decide.
    //
    //  1. the bogus closing tag names the host field — evidence of a mis-closed
    //     host parameter rather than an incidental mention
    if (closingTag !== hostField) continue
    //  2. the absorbed field is real for this tool
    if (!known.has(targetField)) continue
    //  3. it was not otherwise supplied — never overwrite genuine input
    const existing = out[targetField]
    if (existing !== undefined && existing !== null && existing !== '') continue

    // Past the guards the field IS mangled. The only question left is whether
    // the recovery is mechanical or a guess.
    if (RESIDUAL_MARKUP.test(rawValue)) {
      chained.push({ field: hostField, absorbed: targetField })
      continue
    }

    out[hostField] = hostValue.slice(0, match.index).trimEnd()
    out[targetField] = parseSalvagedValue(rawValue)
    salvaged.push({ field: targetField, fromField: hostField })
  }

  return { args: out, salvaged, chained }
}

/** Operator-readable refusal naming what to re-send. */
export function describeChainedArgs(name: string, chained: readonly ChainedEntry[]): string {
  const detail = chained
    .map(c => `"${c.field}" absorbed "${c.absorbed}" and at least one more field`)
    .join('; ')
  return (
    `Malformed tool call for ${name}: ${detail}. A parameter was closed with ` +
    `</fieldName> instead of the required closing tag, so the parameters that ` +
    `followed were folded into it. Too much was run together to separate safely, ` +
    `so nothing was recorded. Re-send the call with every parameter closed correctly.`
  )
}
