import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type HiringSubmission = {
  id: string;
  candidate_name: string;
  candidate_email: string;
  linkedin_url: string | null;
  list_url: string;
  email_1: string;
  email_2: string;
  write_up: string;
  duration: string;
  notes: string | null;
  position: string | null;
  job_slug: string | null;
  source_url: string | null;
  submitted_at: string;
};

type DatabaseWebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: HiringSubmission | null;
  old_record: HiringSubmission | null;
};

const GITHUB_API_VERSION = "2022-11-28";
const EXPECTED_TABLE = "hiring_submissions";
const EXPECTED_SCHEMA = "public";
const EVENT_TYPE = "candidate_submission_created";

function json(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < aBytes.length; index += 1) {
    difference |= aBytes[index] ^ bBytes[index];
  }

  return difference === 0;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return json(
      {
        success: false,
        error: "Method not allowed",
      },
      405,
    );
  }

  try {
    const expectedWebhookSecret = requireEnv("DATABASE_WEBHOOK_SECRET");
    const receivedWebhookSecret =
      request.headers.get("x-webhook-secret")?.trim() ?? "";

    if (
      !receivedWebhookSecret ||
      !timingSafeEqual(receivedWebhookSecret, expectedWebhookSecret)
    ) {
      console.warn("Rejected database webhook: invalid secret");

      return json(
        {
          success: false,
          error: "Unauthorized",
        },
        401,
      );
    }

    let payload: DatabaseWebhookPayload;

    try {
      payload = await request.json();
    } catch {
      return json(
        {
          success: false,
          error: "Invalid JSON body",
        },
        400,
      );
    }

    if (
      payload.type !== "INSERT" ||
      payload.schema !== EXPECTED_SCHEMA ||
      payload.table !== EXPECTED_TABLE ||
      !payload.record
    ) {
      console.log("Ignoring unrelated database webhook", {
        type: payload.type,
        schema: payload.schema,
        table: payload.table,
      });

      return json({
        success: true,
        ignored: true,
      });
    }

    const githubToken = requireEnv("GITHUB_DISPATCH_TOKEN");
    const githubOwner = requireEnv("GITHUB_REPOSITORY_OWNER");
    const githubRepository = requireEnv("GITHUB_REPOSITORY_NAME");

    const dispatchUrl =
      `https://api.github.com/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepository)}/dispatches`;

    /*
     * Keep client_payload below GitHub's repository_dispatch payload limit.
     * The full candidate answers remain in Supabase. GitHub receives the fields
     * needed by the downstream workflow.
     */
    const clientPayload = {
      submission_id: payload.record.id,
      candidate_name: payload.record.candidate_name,
      candidate_email: payload.record.candidate_email,
      linkedin_url: payload.record.linkedin_url,
      list_url: payload.record.list_url,
      duration: payload.record.duration,
      notes: payload.record.notes,
      position: payload.record.position,
      job_slug: payload.record.job_slug,
      source_url: payload.record.source_url,
      submitted_at: payload.record.submitted_at,
    };

    console.log("Dispatching candidate submission to GitHub", {
      submissionId: payload.record.id,
      repository: `${githubOwner}/${githubRepository}`,
      eventType: EVENT_TYPE,
    });

    const githubResponse = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        "User-Agent": "supabase-dispatch-github",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: clientPayload,
      }),
    });

    const responseText = await githubResponse.text();

    if (!githubResponse.ok) {
      console.error("GitHub repository_dispatch failed", {
        status: githubResponse.status,
        response: responseText.slice(0, 1000),
        submissionId: payload.record.id,
      });

      return json(
        {
          success: false,
          error: "GitHub dispatch failed",
          github_status: githubResponse.status,
        },
        502,
      );
    }

    console.log("GitHub repository_dispatch accepted", {
      submissionId: payload.record.id,
      githubStatus: githubResponse.status,
    });

    return json({
      success: true,
      dispatched: true,
      submission_id: payload.record.id,
      github_status: githubResponse.status,
    });
  } catch (error) {
    console.error("dispatch-github failed", error);

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unexpected server error",
      },
      500,
    );
  }
});
