import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { scrapeCompetitorLink } from "../app/lib/competitor-scrape-client.ts";

test("posts taskId and rejects a mismatched platform response", async (t) => {
  let scrapeRequest;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "ready" }));
      return;
    }

    if (request.method === "POST" && request.url === "/scrape") {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        scrapeRequest = JSON.parse(rawBody);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            platformId: "xiaohongshu",
            skillId: "xiaohongshu-scraper",
            inputKind: "account",
            category: "xhs-account",
            outputDir: "/tmp/competitor-20260801-a1",
            dataPath: "/tmp/competitor-20260801-a1/结构化数据.json",
            excelPath: null,
            markdownPath: null,
            imageDirectory: null,
            explicitPaths: ["/tmp/competitor-20260801-a1/结构化数据.json"],
            subjectName: "测试账号",
            itemCount: 1,
          }),
        );
      });
      return;
    }

    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  const douyinRoute = {
    id: "douyin",
    label: "抖音",
    skillId: "douyin-scraper",
    status: "ready",
    bridgeUrl,
    hosts: ["douyin.com"],
  };

  await assert.rejects(
    scrapeCompetitorLink(
      douyinRoute,
      "https://www.douyin.com/user/a",
      "competitor-20260801-a1",
      AbortSignal.timeout(1_000),
    ),
    (error) => error.code === "SCRAPE_RESPONSE_INVALID",
  );
  assert.deepEqual(scrapeRequest, {
    input: "https://www.douyin.com/user/a",
    taskId: "competitor-20260801-a1",
  });
});
