/** Intercept commands: status, enable, disable */

import { getClient } from "../client";
import { INTERCEPT_OPTIONS_QUERY, PAUSE_INTERCEPT, RESUME_INTERCEPT } from "../graphql";

export async function cmdInterceptStatus() {
  const client = await getClient();
  try {
    const result = await client.graphql.query(INTERCEPT_OPTIONS_QUERY, {});
    console.log(JSON.stringify((result as any).interceptOptions, null, 2));
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message, hint: "Intercept may not be available" }, null, 2));
  }
}

export async function cmdInterceptSet(enabled: boolean) {
  const client = await getClient();
  try {
    const mutation = enabled ? RESUME_INTERCEPT : PAUSE_INTERCEPT;
    const result = await client.graphql.mutation(mutation, {});
    const key = enabled ? "resumeIntercept" : "pauseIntercept";
    console.log(JSON.stringify((result as any)[key], null, 2));
  } catch (err: any) {
    console.error(`Failed to ${enabled ? "enable" : "disable"} intercept: ${err.message}`);
  }
}
