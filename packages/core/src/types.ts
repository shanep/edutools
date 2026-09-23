/**
 * Shapes shared across the core, so every module agrees on what a Canvas payload
 * and a form body look like.
 */

/** One Canvas JSON object, typed loosely because Canvas is loose about it. */
export type Payload = Record<string, unknown>;

/**
 * A form body: a flat mapping, or repeated keys as pairs. Canvas uses repeated
 * bracket keys for lists (`assignment[submission_types][]`, quiz answers), which a
 * plain object cannot carry.
 */
export type RequestData = Record<string, string> | Array<[string, string]>;

/** Query parameters, as a mapping or as repeated keys (include[]=a&include[]=b). */
export type RequestParams = Record<string, string | number> | Array<[string, string]>;
