// The remote protocol lives in the engine contracts (ADR-0088, E2b-1) —
// this re-export keeps every existing import path working.
export * from '../../../packages/tickets-engine/src/contracts/remote-protocol';
export type { RefineReply, TicketReply, AttachmentReply } from '../../../packages/tickets-engine/src/contracts/replies';
