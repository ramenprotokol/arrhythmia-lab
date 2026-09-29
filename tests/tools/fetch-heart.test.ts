// tools/fetch_heart.sh downloads a heart archive of about 700 MB and unpacks it. It has to check the archive against its md5
// before it unpacks anything, and stop loudly when the md5 is wrong. Here the real script runs with a stand-in for curl, so
// nothing is downloaded: the "download" is a small archive made for the test.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "tools/fetch_heart.sh");
/** The md5 of 23.tar.gz that tools/README.md gives, from the Zenodo file list. */
const README_MD5 = /`23\.tar\.gz`: `([0-9a-f]{32})`/.exec(readFileSync(join(process.cwd(), "tools/README.md"), "utf8"))?.[1];

let work: string;
let archivePath: string;
let archiveMd5: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "fetch-heart-"));
  // the archive the stand-in curl "downloads": one file inside
  const payload = join(work, "payload");
  mkdirSync(payload);
  writeFileSync(join(payload, "marker.txt"), "unpacked\n");
  archivePath = join(work, "archive.tar.gz");
  const made = spawnSync("tar", ["-czf", archivePath, "-C", payload, "."], { encoding: "utf8" });
  expect(made.status, made.stderr).toBe(0);
  archiveMd5 = createHash("md5").update(readFileSync(archivePath)).digest("hex");
  // a curl that copies that archive to the file named after -o, and notes that it was asked
  mkdirSync(join(work, "bin"));
  const curl = join(work, "bin/curl");
  writeFileSync(curl, `#!/bin/bash\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\necho asked >> "$CURL_LOG"\ncp "$FAKE_ARCHIVE" "$out"\n`);
  chmodSync(curl, 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

let dest: string;
beforeEach(() => {
  dest = mkdtempSync(join(work, "heart-data-"));
});

function run(archive: string, env: Record<string, string> = {}) {
  const log = join(dest, "curl.log");
  const result = spawnSync("bash", [SCRIPT, archive], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, HEART_DATA_DIR: join(dest, "data"), FAKE_ARCHIVE: archivePath, CURL_LOG: log, HEART_MD5: "", ...env },
  });
  return { ...result, downloaded: existsSync(log), unpacked: (name: string) => existsSync(join(dest, "data", name.replace(/\.tar\.gz$/, ""), "marker.txt")) };
}

describe("tools/fetch_heart.sh", () => {
  it("is valid shell", () => {
    expect(spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status).toBe(0);
  });

  it("unpacks an archive whose md5 matches the one it was given", () => {
    const r = run("01.tar.gz", { HEART_MD5: archiveMd5 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.unpacked("01.tar.gz")).toBe(true);
    expect(r.stdout).toContain(archiveMd5);
  });

  it("takes the md5 in capitals too", () => {
    const r = run("01.tar.gz", { HEART_MD5: archiveMd5.toUpperCase() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.unpacked("01.tar.gz")).toBe(true);
  });

  it("stops without unpacking anything when the md5 is wrong, and says what it wanted and what it got", () => {
    const wanted = "0".repeat(32);
    const r = run("01.tar.gz", { HEART_MD5: wanted });
    expect(r.downloaded).toBe(true);
    expect(r.status).not.toBe(0);
    expect(r.unpacked("01.tar.gz")).toBe(false);
    expect(r.stderr).toMatch(/md5/i);
    expect(r.stderr).toContain(wanted);
    expect(r.stderr).toContain(archiveMd5);
    expect(r.stderr).toMatch(/nothing was unpacked/i);
  });

  it("checks archive 23, the one the project uses, against the md5 in tools/README.md, with nothing to set", () => {
    expect(README_MD5, "tools/README.md gives the md5 of 23.tar.gz").toBeDefined();
    // the stand-in's archive is not the real one, so it must be refused, and the md5 it was refused for is the README's
    const r = run("23.tar.gz");
    expect(r.downloaded).toBe(true);
    expect(r.status).not.toBe(0);
    expect(r.unpacked("23.tar.gz")).toBe(false);
    expect(r.stderr).toContain(README_MD5);
    expect(r.stderr).toContain(archiveMd5);
  });

  it("checks archive 23 when no archive is named", () => {
    const log = join(dest, "curl.log");
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, HEART_DATA_DIR: join(dest, "data"), FAKE_ARCHIVE: archivePath, CURL_LOG: log, HEART_MD5: "" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(README_MD5);
    expect(existsSync(join(dest, "data/23/marker.txt"))).toBe(false);
  });

  it("refuses another archive before downloading anything when it has no md5 to check it against", () => {
    const r = run("07.tar.gz");
    expect(r.downloaded).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("HEART_MD5");
    expect(r.stderr).toContain("07.tar.gz");
  });
});
