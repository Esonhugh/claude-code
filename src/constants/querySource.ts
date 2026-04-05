/**
 * Describes how a query was triggered / which source originated the request.
 *
 * The type is intentionally a branded string so call-sites can use template
 * literal values (e.g. `agent:builtin:${agentType}` as QuerySource) while
 * still getting nominal safety in function signatures.
 */
export type QuerySource = string & { readonly __brand?: 'QuerySource' }
