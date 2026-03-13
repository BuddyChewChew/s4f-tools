// s4f-scraper.js
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import initCycleTLS from 'cycletls'; // npm install cycletls

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ====================
// CONFIG SECTION
// ====================
const CONFIG = {
  groups_url: "https://sports4free.ru/channel-api/groups",
  channels_url: "https://sports4free.ru/channel-api/channels",

  cdn_base: "https://cdn-bubbles.xyz/hls",
  stream_url_template: "{base}?id={id}",

  output_dir: "s4f",
  playlist_file: "s4f_playlist.m3u8",
  us_only_file: "s4f_us_only.m3u8",
  json_file: "s4f_data.json",

  impersonate_options: [
    "chrome",
    "chrome124",
    "chrome131",
    "safari",
    "safari_ios",
  ],

  request_timeout: 40000,
  retry_attempts: 4,
  retry_backoff_min: 5000,
  retry_backoff_max: 12000,

  headers: {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://sports4free.ru",
    "Referer": "https://sports4free.ru/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=1",
  },

  us_keywords: ["US|", "UNITED STATES", "USA"],
};

class Sports4FreeScraper {
  private client: any = null;
  private proxies: string | undefined = process.env.PROXY_URL;

  constructor() {
    this.initClient();
  }

  private async initClient() {
    const chosen = CONFIG.impersonate_options[Math.floor(Math.random() * CONFIG.impersonate_options.length)];
    console.log(`Using impersonate: ${chosen}`);

    this.client = await initCycleTLS(chosen, {
      proxy: this.proxies ? { host: this.proxies } : undefined,
      timeout: CONFIG.request_timeout,
    });
  }

  private async fetchWithRetry(url: string): Promise<any> {
    let lastError: any;
    for (let attempt = 1; attempt <= CONFIG.retry_attempts; attempt++) {
      try {
        console.log(`Fetching ${url} (attempt ${attempt}/${CONFIG.retry_attempts})`);
        if (!this.client) throw new Error("Client not initialized");

        const response = await this.client.get(url, {
          headers: CONFIG.headers,
          timeout: CONFIG.request_timeout,
          proxy: this.proxies,
        });

        if (response.status >= 400) {
          throw new Error(`HTTP ${response.status}`);
        }

        return response;
      } catch (err) {
        lastError = err;
        console.log(`Request failed: ${err}`);
        if (attempt === CONFIG.retry_attempts) {
          throw lastError;
        }
        await new Promise(r => setTimeout(r,
          Math.floor(Math.random() * (CONFIG.retry_backoff_max - CONFIG.retry_backoff_min + 1) + CONFIG.retry_backoff_min)
        ));
      }
    }
    throw new Error(`Failed after ${CONFIG.retry_attempts} attempts`);
  }

  async run() {
    console.log("Starting scrape...");

    let groupMap: Record<string, string> = {};
    let channels: any[] = [];

    try {
      if (CONFIG.groups_url) {
        const groupsResp = await this.fetchWithRetry(CONFIG.groups_url);
        const groupsData = groupsResp.body;
        groupMap = Object.fromEntries(
          groupsData
            .filter((g: any) => g?.id)
            .map((g: any) => [String(g.id), String(g.name ?? "UNKNOWN").trim().toUpperCase()])
        );
        await new Promise(r => setTimeout(r, Math.random() * 3000 + 2000));
      }

      const channelsResp = await this.fetchWithRetry(CONFIG.channels_url);
      channels = channelsResp.body;

      if (!Array.isArray(channels)) {
        throw new Error("Channels response is not an array");
      }
    } catch (err) {
      console.error(`SCRAPE FAILED: ${err}`);
      return false;
    }

    channels.sort((a, b) => String(a?.name ?? "").toLowerCase().localeCompare(String(b?.name ?? "").toLowerCase()));

    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

    const m3uHeaderParts = [`#EXTM3U m3u-updated="${timestamp}"`];
    const m3uHeader = m3uHeaderParts.join(" ");

    const m3uFull: string[] = [m3uHeader];
    let m3uUs: string[] | null = CONFIG.us_keywords.length > 0 ? [m3uHeader] : null;

    let processed = 0;

    for (const ch of channels) {
      if (typeof ch !== 'object' || ch === null) continue;

      const chId = String(ch.id ?? "").trim();
      if (!chId) continue;

      const name = String(ch.name ?? "Unknown").trim();
      const logo = String(ch.logo ?? "").trim();
      const groupId = String(ch.groupId ?? ch.group ?? "");
      const groupName = groupMap[groupId] ?? "OTHER";

      const streamUrl = CONFIG.stream_url_template
        .replace("{base}", CONFIG.cdn_base.replace(/\/$/, ""))
        .replace("{id}", chId);

      const extinf = [
        `#EXTINF:-1 tvg-id="${chId}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupName}",${name}`,
        streamUrl
      ].join("\n");

      m3uFull.push(extinf);

      if (m3uUs && CONFIG.us_keywords.some(kw => (groupName + name).toUpperCase().includes(kw.toUpperCase()))) {
        m3uUs.push(extinf);
      }

      processed++;
    }

    await fs.mkdir(path.join(__dirname, CONFIG.output_dir), { recursive: true });

    await fs.writeFile(
      path.join(__dirname, CONFIG.output_dir, CONFIG.playlist_file),
      m3uFull.join("\n"),
      "utf-8"
    );

    if (m3uUs) {
      await fs.writeFile(
        path.join(__dirname, CONFIG.output_dir, CONFIG.us_only_file),
        m3uUs.join("\n"),
        "utf-8"
      );
    }

    await fs.writeFile(
      path.join(__dirname, CONFIG.output_dir, CONFIG.json_file),
      JSON.stringify(channels, null, 2),
      "utf-8"
    );

    console.log(`Success → processed ${processed} channels`);
    return true;
  }
}

async function main() {
  const scraper = new Sports4FreeScraper();
  const success = await scraper.run();
  if (!success) {
    process.exitCode = 1;
  }
  // Optional: await scraper.client?.exit();
}

main().catch(console.error);
