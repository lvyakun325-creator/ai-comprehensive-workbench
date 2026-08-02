import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { scrapeCompetitorLink } from "../app/lib/competitor-scrape-client.ts";

function validDouyinBundle() {
  const outputDir = "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1";
  return {
    platformId: "douyin",
    skillId: "douyin-scraper",
    inputKind: "account",
    category: "douyin-account",
    outputDir,
    dataPath: `${outputDir}/structured.json`,
    excelPath: `${outputDir}/account.xlsx`,
    markdownPath: `${outputDir}/account.md`,
    imageDirectory: `${outputDir}/images`,
    explicitPaths: [
      `${outputDir}/structured.json`,
      `${outputDir}/account.xlsx`,
      `${outputDir}/account.md`,
      `${outputDir}/images`,
    ],
    subjectName: "测试账号",
    itemCount: 1,
  };
}

async function startBridge(t, payload) {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        status: "ready",
        service: "douyin-scraper",
        outputDir: "/controlled/outputs/competitor-insight/douyin",
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/scrape") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  return {
    id: "douyin",
    label: "抖音",
    skillId: "douyin-scraper",
    status: "ready",
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    hosts: ["douyin.com"],
  };
}

test("posts taskId and rejects a mismatched platform response", async (t) => {
  let scrapeRequest;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        status: "ready",
        service: "douyin-scraper",
        outputDir: "/controlled/outputs/competitor-insight/douyin",
      }));
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

test("wrong scraper health identity fails closed before scrape receives the link", async (t) => {
  let scrapeCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({
        ok: true,
        status: "ready",
        service: "wrong-service",
        outputDir: "/controlled/outputs/competitor-insight/douyin",
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/scrape") scrapeCount += 1;
    response.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const route = {
    id: "douyin",
    label: "抖音",
    skillId: "douyin-scraper",
    status: "ready",
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    hosts: ["douyin.com"],
  };

  await assert.rejects(
    scrapeCompetitorLink(
      route,
      "https://www.douyin.com/user/public-account",
      "competitor-20260801-a1",
    ),
    (error) => error?.code === "SCRAPE_BRIDGE_UNAVAILABLE",
  );
  assert.equal(scrapeCount, 0);
});

for (const [pathField, escapingPath] of [
  ["dataPath", "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/../outside.json"],
  ["excelPath", "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/../outside.xlsx"],
  ["markdownPath", "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/../outside.md"],
  ["imageDirectory", "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/../outside-images"],
  ["explicitPaths", [
    "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/structured.json",
    "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/../outside.json",
  ]],
]) {
  test(`rejects an escaping ${pathField} path`, async (t) => {
    const bundle = { ...validDouyinBundle(), [pathField]: escapingPath };
    if (pathField === "dataPath") {
      bundle.explicitPaths = [
        escapingPath,
        "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/account.xlsx",
        "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/account.md",
        "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/images",
      ];
    }
    const route = await startBridge(t, bundle);

    await assert.rejects(
      scrapeCompetitorLink(
        route,
        "https://www.douyin.com/user/a",
        "competitor-20260801-a1",
        AbortSignal.timeout(1_000),
      ),
      (error) => error.code === "SCRAPE_RESPONSE_INVALID",
    );
  });
}
