/**
 * Makes ids that are unique in a session, and in practice everywhere. The loop
 * uses it for the `callId` of every tool call and for the ids of the drafts in
 * the events. The host only provides the implementation.
 *
 * @public
 */
export interface IdGenerator {
  next(): string;
}
