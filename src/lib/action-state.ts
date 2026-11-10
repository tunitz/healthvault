/** Result a form action reports back to the client, so validation never crashes the page. */
export type ActionState = {
  ok: boolean;
  error?: string;
  message?: string;
};

export const IDLE_ACTION: ActionState = { ok: true };
