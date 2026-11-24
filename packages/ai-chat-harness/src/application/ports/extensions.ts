/**
 * The extension points of the loop (context providers, skills, hooks). They
 * come with P3; until then the set is empty and the loop does not read it.
 *
 * @public
 */
export type Extensions = Readonly<Record<string, never>>;
