#!/usr/bin/env node
import {
  cancel,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { Command } from "commander";
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

async function submitUrlForArchiving(
  url: string,
  debug = false,
): Promise<string> {
  const postBody = new URLSearchParams();
  postBody.append("url", url);
  postBody.append("capture_all", "on");
  const response = await fetch(ARCHIVE_SAVE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://web.archive.org/save/",
      "User-Agent":
        "web-archive-cli/1.0 (+https://github.com/The-Best-Codes/web-archive-cli)", // If the user agent causes issues, change it to `"CustomArchiverClient/1.0 (+https://archive.org/details/savepagenow)"`
    },
    body: postBody.toString(),
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const html = await response.text();
  if (debug) {
    console.log("[DEBUG] HTML response from submitUrlForArchiving:");
    console.log(html);
  }

  const errorDivMatch = html.match(
    /<div class="col-md-4 col-md-offset-4">([\s\S]*?)<\/div>/,
  );
  if (errorDivMatch && errorDivMatch[1]) {
    const divContent = errorDivMatch[1];
    const h2Match = divContent.match(/<h2>\s*Sorry\s*<\/h2>/i);
    const aMatch = divContent.match(
      /<a\s+href=["']\/save["']\s*>\s*Return to Save Page Now\s*<\/a>/i,
    );
    const pMatch = divContent.match(/<p>([\s\S]*?)<\/p>/i);
    if (h2Match && aMatch) {
      if (pMatch && pMatch[1]) {
        throw new Error(
          `Error from Wayback Machine: ${pMatch[1].replace(/\s+/g, " ").trim()}`,
        );
      }
    } else if (pMatch && pMatch[1]) {
      log.warn(
        `Possible error message: ${pMatch[1].replace(/\s+/g, " ").trim()}`,
      );
    }
  }
  const jobMatch = html.match(/spn\.watchJob\("([^"]+)"/);
  if (jobMatch && jobMatch[1]) {
    return jobMatch[1];
  } else {
    throw new Error("Failed to extract job ID from response HTML.");
  }
}

async function getJobStatus(
  jobId: string,
): Promise<JobStatus & { retry_after?: number }> {
  const pollUrl = `${POLL_STATUS_BASE_URL}${jobId}?_t=${Date.now()}`;
  const response = await fetch(pollUrl, {
    method: "GET",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent":
        "web-archive-cli/1.0 (+https://github.com/The-Best-Codes/web-archive-cli)",
    },
  });
  const retryAfterHeader = response.headers.get("Retry-After");
  let retryAfter = retryAfterHeader
    ? parseInt(retryAfterHeader, 10) * 1000
    : undefined;
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

async function pollJob(
  jobId: string,
  timeoutMs: number,
  debug = false,
  spinnerFn: any,
): Promise<JobStatus> {
  const startTime = Date.now();
  let pollInterval = DEFAULT_POLL_INTERVAL_MS;
  let lastProgressMsg = "";
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await getJobStatus(jobId);
      if (debug) {
        console.log(`[DEBUG] Polled job status: ${JSON.stringify(status)}`);
      }
      if (status.status === "pending") {
        let progressMsg = "";
        if (status.download_size && status.total_size) {
          progressMsg = `Downloaded ${status.download_size}/${status.total_size} resources`;
        } else if (status.resources) {
          progressMsg = `Downloaded ${status.resources.length} resources so far`;
        } else {
          progressMsg = "Downloading resources...";
        }
        if (progressMsg !== lastProgressMsg) {
          if (spinnerFn && typeof spinnerFn.message === "function") {
            spinnerFn.message(
              `Polling job status for: ${jobId}${progressMsg ? ` (${progressMsg})` : ""}`,
            );
          } else {
            log.info(progressMsg);
          }
          if (debug) {
            console.log(`[DEBUG] Progress message: ${progressMsg}`);
          }
          lastProgressMsg = progressMsg;
        }
      }
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
  throw new Error(
    `Polling for job ${jobId} timed out after ${timeoutMs / 1000} seconds.`,
  );
}

async function archiveAndPoll(
  urlToArchive: string,
  keepProtocol: boolean,
  debug = false,
  timeoutMs?: number,
  cacheBuster: string = "none",
) {
  let normalizedUrl = normalizeUrl(urlToArchive, keepProtocol);
  const rand = () => Math.random().toString(36).slice(2);
  if (cacheBuster === "frag") {
    normalizedUrl += `#${rand()}=${rand()}`;
  } else if (cacheBuster === "query") {
    log.warn(
      `Warning: Query string cache-busting will only save the full URL, including the query. The base URL (${normalizedUrl}) will not be archived or searchable.`,
    );
    if (normalizedUrl.includes("?")) {
      normalizedUrl += `&${rand()}=${rand()}`;
    } else {
      normalizedUrl += `?${rand()}=${rand()}`;
    }
  }
  const s = spinner();
  s.start(`Submitting URL to archive: ${normalizedUrl}`);
  let jobId: string;
  try {
    jobId = await submitUrlForArchiving(normalizedUrl, debug);
    s.message(`Polling job status for: ${jobId}`);
  } catch (error: any) {
    s.stop("Failed to submit URL.", 1);
    log.error(error.message || String(error));
    return;
  }
  try {
    const status = await pollJob(
      jobId,
      timeoutMs ?? POLLING_TIMEOUT_MS,
      debug,
      s,
    );
    if (status.status === "success") {
      s.stop("Archiving completed!", 0);
      const archivedUrl = `/web/${status.timestamp}/${status.original_url}`;
      log.success(`Archived: https://web.archive.org${archivedUrl}`);
    } else {
      s.stop("Archiving failed.", 1);
      log.error(status.message || "Unknown error");
    }
  } catch (error: any) {
    s.stop("Archiving failed.", 1);
    log.error(error.message || String(error));
  }
}

const program = new Command();
program
  .name("web-archive-cli")
  .description("archive websites using the Internet Archive Save API")
  .version(packageJson.version);

program
  .argument("[url]", "the URL to archive (omit to enter interactive mode)")
  .option("-k, --keep-protocol", "keep http(s):// in URL", false)
  .option("--debug", "enable verbose debug output", false)
  .option(
    "-t, --timeout <ms>",
    "polling timeout in milliseconds",
    (val) => parseInt(val, 10),
    POLLING_TIMEOUT_MS,
  )
  .option(
    "--cache-buster <type>",
    "append a cache-busting value: none, 'frag' for fragment, 'query' for query string",
    "none",
  )
  .action(
    async (
      urlArg: string | undefined,
      opts: {
        keepProtocol?: boolean;
        debug?: boolean;
        timeout?: number;
        cacheBuster?: string;
      },
    ) => {
      const debug = !!opts.debug;
      const timeoutMs = opts.timeout;
      const cacheBuster = opts.cacheBuster;
      if (urlArg) {
        await archiveAndPoll(
          urlArg,
          !!opts.keepProtocol,
          debug,
          timeoutMs,
          cacheBuster,
        );
        return;
      }
      // Interactive mode
      intro("Web Archive CLI");
      let url: string | symbol | undefined;
      while (true) {
        url = await text({
          message: "Enter the URL to archive:",
          validate: (val) =>
            val && typeof val === "string" && val.trim() !== ""
              ? undefined
              : "URL is required",
        });
        if (isCancel(url)) {
          cancel("Operation cancelled.");
          return;
        }
        if (url && typeof url === "string" && url.trim() !== "") break;
      }
      let keepProtocol = false;
      // Only ask about protocol if URL starts with http:// or https://
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        log.warn(
          "Warning: Including the protocol (http:// or https://) will usually cause archiving to fail. It's recommended to strip it.",
        );
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
          return;
        }
        keepProtocol = protoChoice as boolean;
      }
      await archiveAndPoll(
        url as string,
        keepProtocol,
        debug,
        timeoutMs,
        cacheBuster,
      );
      outro("Done!");
    },
  );

program.parseAsync(process.argv);
