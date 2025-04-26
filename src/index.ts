#!/usr/bin/env bun
import { Command } from "commander";
import { intro, outro, text, select, spinner, isCancel, cancel, log } from "@clack/prompts";
import { URLSearchParams } from "url";
import packageJson from "../package.json";

const ARCHIVE_SAVE_URL = "https://web.archive.org/save/";
const POLL_STATUS_BASE_URL = "https://web.archive.org/save/status/";
const POLLING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout
const DEFAULT_POLL_INTERVAL_MS = 6000; // 6 seconds

interface JobStatus {
  job_id: string;
  status: "pending" | "success" | "error";
  resources?: string[];
  download_size?: number;
  total_size?: number;
  timestamp?: string;
  original_url?: string;
  message?: string;
}

function normalizeUrl(url: string, keepProtocol = false): string {
  if (keepProtocol) return url;
  return url.replace(/^https?:\/\//, "");
}

async function submitUrlForArchiving(url: string): Promise<string> {
  const postBody = new URLSearchParams();
  postBody.append("url", url);
  postBody.append("capture_all", "on");
  const response = await fetch(ARCHIVE_SAVE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://web.archive.org/save/",
      "User-Agent": "web-archive-cli/1.0 (+https://github.com/The-Best-Codes/web-archive-cli)",
    },
    body: postBody.toString(),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const html = await response.text();
  const jobMatch = html.match(/spn\.watchJob\("([^"]+)"/);
  if (jobMatch && jobMatch[1]) {
    return jobMatch[1];
  } else {
    throw new Error("Failed to extract job ID from response HTML.");
  }
}

async function getJobStatus(jobId: string): Promise<JobStatus & { retry_after?: number }> {
  const pollUrl = `${POLL_STATUS_BASE_URL}${jobId}?_t=${Date.now()}`;
  const response = await fetch(pollUrl, {
    method: "GET",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "web-archive-cli/1.0 (+https://github.com/The-Best-Codes/web-archive-cli)",
    },
  });
  const retryAfterHeader = response.headers.get("Retry-After");
  let retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined;
  if (!response.ok) {
    let errorBody: any = {};
    try {
      errorBody = await response.json();
    } catch {}
    const errorStatus: JobStatus & { retry_after?: number } = {
      job_id: jobId,
      status: "error",
      message: `HTTP status ${response.status}${errorBody.message ? ": " + errorBody.message : ""}`,
      ...errorBody,
    };
    if (retryAfter) errorStatus.retry_after = retryAfter;
    throw errorStatus;
  }
  const status: any = await response.json();
  const statusWithRetry: JobStatus & { retry_after?: number } = status;
  if (retryAfter) statusWithRetry.retry_after = retryAfter;
  return statusWithRetry;
}

async function pollJob(jobId: string, timeoutMs: number): Promise<JobStatus> {
  const startTime = Date.now();
  let pollInterval = DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await getJobStatus(jobId);
      if (status.status !== "pending") {
        return status;
      }
      pollInterval = status.retry_after || DEFAULT_POLL_INTERVAL_MS;
      pollInterval = Math.max(pollInterval, 2000);
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) return status;
      const waitTime = Math.min(pollInterval, remaining);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    } catch (error: any) {
      if (error.job_id === jobId && error.status === "error") {
        pollInterval = error.retry_after || DEFAULT_POLL_INTERVAL_MS;
        pollInterval = Math.max(pollInterval, 2000);
        const elapsed = Date.now() - startTime;
        const remaining = timeoutMs - elapsed;
        if (remaining <= 0) throw error;
        const waitTime = Math.min(pollInterval, remaining);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`Polling for job ${jobId} timed out after ${timeoutMs / 1000} seconds.`);
}

async function archiveAndPoll(urlToArchive: string, keepProtocol: boolean) {
  const normalizedUrl = normalizeUrl(urlToArchive, keepProtocol);
  const s = spinner();
  s.start(`Submitting URL to archive: ${normalizedUrl}`);
  let jobId: string;
  try {
    jobId = await submitUrlForArchiving(normalizedUrl);
    s.message(`Polling job status for: ${jobId}`);
  } catch (error: any) {
    s.stop("Failed to submit URL.");
    log.error(error.message || String(error));
    return;
  }
  try {
    const status = await pollJob(jobId, POLLING_TIMEOUT_MS);
    if (status.status === "success") {
      s.stop("Archiving completed!");
      const archivedUrl = `/web/${status.timestamp}/${status.original_url}`;
      log.success(`Archived: https://web.archive.org${archivedUrl}`);
    } else {
      s.stop("Archiving failed.");
      log.error(status.message || "Unknown error");
    }
  } catch (error: any) {
    s.stop("Archiving failed.");
    log.error(error.message || String(error));
  }
}

const program = new Command();
program
  .name("web-archive-cli")
  .description("Archive websites using the Internet Archive Save API")
  .version(packageJson.version);

program
  .argument("[url]", "The URL to archive (omit to enter interactive mode)")
  .option("-k, --keep-protocol", "Keep http(s):// in URL (default strips it)")
  .action(async (urlArg: string | undefined, opts: { keepProtocol?: boolean }) => {
    if (urlArg) {
      await archiveAndPoll(urlArg, !!opts.keepProtocol);
      return;
    }
    // Interactive mode
    intro("🌐 Web Archive CLI");
    let url: string | symbol | undefined;
    while (true) {
      url = await text({
        message: "Enter the URL to archive:",
        validate: (val) => val && typeof val === "string" && val.trim() !== "" ? undefined : "URL is required",
      });
      if (isCancel(url)) {
        cancel("Operation cancelled.");
        outro("Goodbye!");
        return;
      }
      if (url && typeof url === "string" && url.trim() !== "") break;
    }
    let keepProtocol = false;
    const protoChoice = await select({
      message: "How should protocol be handled?",
      options: [
        { value: false, label: "Strip http(s):// (recommended)" },
        { value: true, label: "Keep http(s)://" },
      ],
      initialValue: false,
    });
    if (isCancel(protoChoice)) {
      cancel("Operation cancelled.");
      outro("Goodbye!");
      return;
    }
    keepProtocol = protoChoice as boolean;
    await archiveAndPoll(url as string, keepProtocol);
    outro("Done!");
  });

program.parseAsync(process.argv);