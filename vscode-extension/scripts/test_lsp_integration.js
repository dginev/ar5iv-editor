const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

class LspProcess {
  constructor(executable) {
    this.child = child_process.spawn(executable, ["--server"]);
    this.buffer = Buffer.alloc(0); // BYTES: Content-Length counts UTF-8 bytes, not JS chars
    this.pendingRequests = new Map();
    this.nextId = 2;

    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseBuffer();
    });

    this.child.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        console.log(`[LSP Server Log] ${line}`);
      }
    });

    // Send LSP initialization handshake
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
  }

  send(msg) {
    const body = JSON.stringify(msg);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    this.child.stdin.write(payload, "utf-8");
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      this.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  parseBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }
      const headerPart = this.buffer.subarray(0, headerEnd).toString("utf-8");
      let contentLength = 0;
      for (const line of headerPart.split("\r\n")) {
        if (line.toLowerCase().startsWith("content-length:")) {
          const parsedLen = parseInt(line.split(":")[1].trim(), 10);
          if (!isNaN(parsedLen)) {
            contentLength = parsedLen;
          }
        }
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) {
        break;
      }
      const bodyPart = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const msg = JSON.parse(bodyPart);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const resolve = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } catch (err) {
        console.error("Failed to parse LSP response body:", err);
      }
    }
  }

  dispose() {
    this.child.kill();
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findBinary() {
  if (process.env.LATEXML_OXIDE_PATH && fs.existsSync(process.env.LATEXML_OXIDE_PATH)) {
    return process.env.LATEXML_OXIDE_PATH;
  }

  const siblingDebug = path.resolve(__dirname, "../../../latexml-oxide/target/debug/latexml_oxide");
  if (fs.existsSync(siblingDebug)) {
    return siblingDebug;
  }

  const siblingRelease = path.resolve(__dirname, "../../../latexml-oxide/target/release/latexml_oxide");
  if (fs.existsSync(siblingRelease)) {
    return siblingRelease;
  }

  // Check PATH
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "latexml_oxide");
    if (fs.existsSync(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {}
    }
  }

  return null;
}

async function run() {
  const binaryPath = findBinary();
  if (!binaryPath) {
    console.error("Error: Could not resolve latexml_oxide executable.");
    console.error("Please ensure latexml_oxide is compiled or available on PATH, or set LATEXML_OXIDE_PATH.");
    process.exit(1);
  }
  console.log(`Using latexml_oxide binary: ${binaryPath}`);

  // Set up temporary scratch directory
  const testDir = path.join(os.tmpdir(), "ar5iv_lsp_test_" + Math.random().toString(36).substring(7));
  fs.mkdirSync(testDir, { recursive: true });

  const docPath = path.join(testDir, "test_doc.tex");
  const docUri = `file://${docPath}`;

  const stylePath = path.join(testDir, "localstyle.sty");
  fs.writeFileSync(stylePath, "% localstyle.sty\n\\newcommand{\\mystyle}{Version A}\n");

  console.log("======================================================================");
  console.log("STAGES OF END-TO-END VS CODE LSP INTEGRATION VERIFICATION");
  console.log("======================================================================");

  console.log("\n[STAGE 1] Spawning latexml-oxide --server as persistent LSP daemon...");
  const lsp = new LspProcess(binaryPath);
  await sleep(500); // Wait briefly for initialization handshake

  // Define LaTeX source elements
  const preamble1 = "\\documentclass{article}\n\\usepackage{localstyle}\n\\newcommand{\\foo}{Hello Preamble}\n\\begin{document}\n";
  // Deliberately multi-byte (typographic dash + pi): a byte/char framing
  // mismatch hangs on this response, so the run fails loudly instead of
  // passing on ASCII-only luck.
  const body1 = "This is our initial body text \u2014 with $\\pi$. \\foo. Local style: \\mystyle";

  console.log("\n[STAGE 2] First compile: Cache Miss (needs to build preamble & dependencies)...");
  let t0 = performance.now();
  let resp = await lsp.request("latexml/convert", {
    uri: docUri,
    text: preamble1 + body1,
  });
  let t1 = performance.now();
  console.log(`Compile completed in ${(t1 - t0).toFixed(2)} ms`);
  if (resp && resp.result) {
    console.log(`Result Status: ${resp.result.status}`);
    console.log(`Result Snippet: ${resp.result.html.substring(0, 160)}...`);
  } else {
    console.error("Error in Stage 2:", resp);
    cleanup(testDir);
    process.exit(1);
  }

  console.log("\n[STAGE 3] Second compile: Cache Hit (editing body text only -> using CoW process fork)...");
  const body2 = "This is our edited body text! More content is here. \\foo. Local style: \\mystyle";
  t0 = performance.now();
  resp = await lsp.request("latexml/convert", {
    uri: docUri,
    text: preamble1 + body2,
  });
  t1 = performance.now();
  console.log(`Compile completed in ${(t1 - t0).toFixed(2)} ms`);
  if (resp && resp.result) {
    console.log(`Result Status: ${resp.result.status}`);
    console.log(`Result Snippet: ${resp.result.html.substring(0, 160)}...`);
  } else {
    console.error("Error in Stage 3:", resp);
    cleanup(testDir);
    process.exit(1);
  }

  console.log("\n[STAGE 4] Third compile: Cache Miss due to Preamble edit...");
  const preamble2 = "\\documentclass{article}\n\\usepackage{localstyle}\n\\newcommand{\\foo}{Greetings Preamble}\n\\begin{document}\n";
  t0 = performance.now();
  resp = await lsp.request("latexml/convert", {
    uri: docUri,
    text: preamble2 + body2,
  });
  t1 = performance.now();
  console.log(`Compile completed in ${(t1 - t0).toFixed(2)} ms`);
  if (resp && resp.result) {
    console.log(`Result Status: ${resp.result.status}`);
    console.log(`Result Snippet: ${resp.result.html.substring(0, 160)}...`);
  } else {
    console.error("Error in Stage 4:", resp);
    cleanup(testDir);
    process.exit(1);
  }

  console.log("\n[STAGE 5] Fourth compile: Cache Hit on modified preamble body...");
  t0 = performance.now();
  resp = await lsp.request("latexml/convert", {
    uri: docUri,
    text: preamble2 + body2,
  });
  t1 = performance.now();
  console.log(`Compile completed in ${(t1 - t0).toFixed(2)} ms`);
  if (resp && resp.result) {
    console.log(`Result Status: ${resp.result.status}`);
  } else {
    console.error("Error in Stage 5:", resp);
    cleanup(testDir);
    process.exit(1);
  }

  console.log("\n[STAGE 6] Fifth compile: Cache Miss due to Dependency change (localstyle.sty)...");
  console.log("--> Modifying localstyle.sty on disk...");
  fs.writeFileSync(stylePath, "% localstyle.sty\n\\newcommand{\\mystyle}{Version B (Updated!)}\n");
  const now = new Date();
  fs.utimesSync(stylePath, now, now);

  t0 = performance.now();
  resp = await lsp.request("latexml/convert", {
    uri: docUri,
    text: preamble2 + body2,
  });
  t1 = performance.now();
  console.log(`Compile completed in ${(t1 - t0).toFixed(2)} ms`);
  if (resp && resp.result) {
    console.log(`Result Status: ${resp.result.status}`);
    console.log(`Result Snippet: ${resp.result.html.substring(0, 160)}...`);
  } else {
    console.error("Error in Stage 6:", resp);
    cleanup(testDir);
    process.exit(1);
  }

  console.log("\n[STAGE 7] Cleaning up and disposing of processes...");
  lsp.dispose();
  cleanup(testDir);
  console.log("Verification finished successfully!");
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

run();
