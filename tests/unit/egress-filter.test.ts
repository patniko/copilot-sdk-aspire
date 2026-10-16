import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyAddress, EgressError, EgressFilter, internalEndpointsFromEnvironment, parseIPv6Value, resolveRedirect,
  type AddressCategory, type EgressFilterOptions,
} from "@copilot-agent/service-defaults";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A filter whose DNS answers come from `answers` and whose connections all land on the loopback test server. */
function harness(answers: Record<string, string[]>, options: Omit<EgressFilterOptions, "testing"> = {}) {
  const lookups: string[] = [];
  const dials: string[] = [];
  const filter = new EgressFilter({
    ...options,
    testing: {
      resolve: async (name) => {
        lookups.push(name);
        const list = answers[name.replace(/\.$/, "")];
        if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
        return list.map((address) => ({ address, family: address.includes(":") ? 6 as const : 4 as const }));
      },
      dial: (address) => {
        dials.push(address.address);
        return { address: "127.0.0.1", family: 4 };
      },
    },
  });
  return { filter, lookups, dials };
}

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EgressError);
  return error as EgressError;
}

describe("address classification", () => {
  const table: Array<[string, AddressCategory]> = [
    ["8.8.8.8", "public"], ["93.184.216.34", "public"], ["172.32.0.1", "public"], ["2606:4700::6810:84e5", "public"],
    ["0.0.0.0", "unspecified"], ["0.255.255.255", "unspecified"], ["::", "unspecified"],
    ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["::1", "loopback"],
    ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.0.1", "private"],
    ["100.64.0.1", "shared"], ["100.127.255.255", "shared"],
    ["169.254.0.1", "link-local"], ["fe80::1", "link-local"], ["fe80::1%eth0", "link-local"], ["febf::1", "link-local"],
    ["169.254.169.254", "metadata"], ["169.254.170.2", "metadata"], ["100.100.100.200", "metadata"], ["192.0.0.192", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["168.63.129.16", "cloud-platform"],
    ["192.0.0.8", "protocol-assignment"], ["2001:2::1", "protocol-assignment"],
    ["192.0.2.1", "documentation"], ["198.51.100.1", "documentation"], ["203.0.113.1", "documentation"], ["2001:db8::1", "documentation"], ["3fff::1", "documentation"],
    ["198.18.0.1", "benchmarking"], ["198.19.255.255", "benchmarking"],
    ["224.0.0.1", "multicast"], ["239.255.255.255", "multicast"], ["ff02::1", "multicast"],
    ["255.255.255.255", "broadcast"], ["240.0.0.1", "reserved"], ["192.88.99.1", "reserved"], ["4000::1", "reserved"], ["5f00::1", "reserved"],
    ["fc00::1", "unique-local"], ["fdff:ffff::1", "unique-local"], ["fec0::1", "site-local"],
    ["::ffff:127.0.0.1", "ipv4-mapped"], ["::ffff:7f00:1", "ipv4-mapped"], ["::ffff:8.8.8.8", "ipv4-mapped"], ["0:0:0:0:0:ffff:a9fe:a9fe", "ipv4-mapped"],
    ["::127.0.0.1", "ipv4-compatible"], ["::a9fe:a9fe", "ipv4-compatible"],
    ["::ffff:0:7f00:1", "ipv4-translated"], ["64:ff9b::7f00:1", "ipv4-translated"], ["64:ff9b::808:808", "ipv4-translated"], ["64:ff9b:1::1", "ipv4-translated"],
    ["2002:7f00:1::1", "6to4"], ["2001::1", "teredo"], ["100::1", "discard"],
  ];
  it.each(table)("classifies %s as %s", (address, category) => {
    expect(classifyAddress(address).category).toBe(category);
  });

  it("parses compressed, embedded, and full IPv6 forms consistently and rejects malformed ones", () => {
    expect(parseIPv6Value("::ffff:1.2.3.4")).toBe(parseIPv6Value("0:0:0:0:0:ffff:102:304"));
    expect(parseIPv6Value("1:2:3:4:5:6:1.2.3.4")).toBe(parseIPv6Value("1:2:3:4:5:6:102:304"));
    expect(parseIPv6Value("2001:DB8::1")).toBe(parseIPv6Value("2001:db8:0:0:0:0:0:1"));
    for (const invalid of ["1::2::3", ":1:2", "1:2:3:4:5:6:7:8:9", "12345::", "1:2:3:4:5:6:7:1.2.3.4", "::1.2.3", "g::1", ""]) {
      expect(parseIPv6Value(invalid)).toBeUndefined();
    }
    for (const invalid of ["1.2.3", "256.1.1.1", "01.2.3.4", "localhost", "1.2.3.4/8"]) {
      expect(() => classifyAddress(invalid)).toThrow(EgressError);
    }
  });
});

describe("URL vetting", () => {
  it.each([
    ["http://2130706433/", "loopback"], ["http://0x7f.1/", "loopback"], ["http://017700000001/", "loopback"],
    ["http://0177.0.0.1/", "loopback"], ["http://127.1/", "loopback"], ["http://127.0.0.1./", "loopback"],
    ["http://127%2e0%2e0%2e1/", "loopback"], ["http://0xA9FEA9FE/latest/meta-data/", "metadata"], ["http://2852039166/", "metadata"],
    ["http://169.254.169.254./", "metadata"], ["http://0/", "unspecified"], ["http://[::]/", "unspecified"],
    ["http://[::1]:8080/", "loopback"], ["http://[::ffff:127.0.0.1]/", "ipv4-mapped"], ["http://[::ffff:169.254.169.254]/", "ipv4-mapped"],
    ["http://[0:0:0:0:0:ffff:7f00:1]/", "ipv4-mapped"], ["http://[::127.0.0.1]/", "ipv4-compatible"], ["http://[64:ff9b::a9fe:a9fe]/", "ipv4-translated"],
    ["http://[fe80::1]/", "link-local"], ["http://[fd00:ec2::254]/", "metadata"], ["http://[fc00::1]/", "unique-local"],
    ["http://[ff02::1]/", "multicast"], ["http://[2002:7f00:1::]/", "6to4"], ["http://10.0.0.1/", "private"], ["http://100.64.1.1/", "shared"],
    ["https://168.63.129.16/", "cloud-platform"], ["http://①②⑦.0.0.1/", "loopback"],
  ])("refuses %s (%s) without any DNS lookup", async (url, category) => {
    const { filter, lookups } = harness({});
    const error = await refusal(filter.vet(url));
    expect(error.code).toBe("address");
    expect(error.category).toBe(category);
    expect(lookups).toEqual([]);
  });

  it.each([
    "http://localhost/", "http://LOCALHOST./", "http://localhost.:8080/", "http://app.localhost/", "http://printer/",
    "http://printer./", "http://nas.local/", "http://metadata.google.internal/computeMetadata/v1/", "http://router.home.arpa/",
    "http://1.0.0.127.in-addr.arpa/", "http://box.localdomain/", "http://example.com../", "http://abc.onion/",
  ])("refuses the special-use or malformed host name in %s before DNS", async (url) => {
    const { filter, lookups } = harness({});
    expect((await refusal(filter.vet(url))).code).toBe("hostname");
    expect(lookups).toEqual([]);
  });

  it.each([
    ["ftp://example.com/file", "scheme"], ["file:///etc/passwd", "scheme"], ["gopher://example.com/", "scheme"],
    ["data:text/plain,hello", "scheme"], ["javascript:alert(1)", "scheme"], ["ws://example.com/", "scheme"],
    ["http://user:secret@example.com/", "credentials_in_url"], ["http://:secret@example.com/", "credentials_in_url"], ["not a url", "invalid_url"],
  ])("refuses %s with %s", async (url, code) => {
    expect((await refusal(harness({}).filter.vet(url))).code).toBe(code);
  });

  it("resolves absolute names once, keeps trailing-dot hosts public, and refuses DNS answers that mix public and non-public addresses", async () => {
    const { filter, lookups } = harness({
      "example.com": ["93.184.216.34", "2606:2800:220:1::1"],
      "mixed.example": ["93.184.216.34", "10.0.0.7"],
      "mixed-v6.example": ["2606:2800:220:1::1", "::1"],
      "mapped.example": ["::ffff:169.254.169.254"],
      "metadata-alias.example": ["169.254.169.254"],
      "empty.example": [],
      "garbage.example": ["not-an-address"],
    });
    const vetted = await filter.vet("https://example.com./path?q=1");
    expect(vetted.hostname).toBe("example.com");
    expect(vetted.port).toBe(443);
    expect(vetted.addresses.map((entry) => entry.category)).toEqual(["public", "public"]);
    expect(lookups).toEqual(["example.com."]);
    expect((await refusal(filter.vet("http://mixed.example/"))).category).toBe("private");
    expect((await refusal(filter.vet("http://mixed-v6.example/"))).category).toBe("loopback");
    expect((await refusal(filter.vet("http://mapped.example/"))).category).toBe("ipv4-mapped");
    expect((await refusal(filter.vet("http://metadata-alias.example/"))).category).toBe("metadata");
    expect((await refusal(filter.vet("http://empty.example/"))).code).toBe("dns");
    expect((await refusal(filter.vet("http://garbage.example/"))).code).toBe("dns");
    const missing = await refusal(filter.vet("http://missing.example/"));
    expect(missing.code).toBe("dns");
    expect(missing.message).not.toContain("missing.example");
  });

  it("refuses deployment endpoints by name and port, by resolved address and port, and by operator networks, even when they are public", async () => {
    const { filter } = harness({
      "db.example.net": ["20.1.2.3"], "alias.example": ["20.1.2.3"], "api.internal-svc.example": ["52.1.1.1"], "range.example": ["40.10.20.30"],
      "admin.example.net": ["20.9.9.9"], localhost: ["127.0.0.1", "::1"],
    }, {
      internal: [{ host: "db.example.net", port: 5432 }, { host: "52.1.1.1", port: 443 }, { host: "localhost", port: 5123 }, { host: "admin.example.net" }],
      deniedNetworks: ["40.10.0.0/16"],
    });
    expect((await refusal(filter.vet("http://db.example.net:5432/"))).code).toBe("internal");
    expect((await refusal(filter.vet("http://alias.example:5432/"))).code).toBe("internal");
    expect((await filter.vet("http://alias.example/")).addresses[0]!.category).toBe("public");
    expect((await refusal(filter.vet("https://api.internal-svc.example/"))).code).toBe("internal");
    expect((await refusal(filter.vet("http://range.example:8443/"))).code).toBe("internal");
    expect((await refusal(filter.vet("https://admin.example.net:8443/"))).code).toBe("internal");
    expect((await refusal(filter.vet("http://localhost:5123/"))).code).toBe("hostname");
  });

  it("refuses port 0, which Node would replace with the default port past a port-scoped rule", async () => {
    const { filter, lookups } = harness({ "db.example.net": ["20.1.2.3"] }, { internal: [{ host: "20.1.2.3", port: 443 }] });
    for (const url of ["https://db.example.net:0/", "http://example.com:0/", "https://20.1.2.3:0/"]) {
      expect((await refusal(filter.vet(url))).code).toBe("invalid_url");
    }
    expect(lookups).toEqual([]);
    expect((await refusal(filter.vet("https://db.example.net/"))).code).toBe("internal");
  });

  it("fails closed until every internal host name has resolved once, then keeps the last good addresses", async () => {
    let available = false;
    const filter = new EgressFilter({
      internal: [{ host: "db.example.net", port: 5432 }],
      internalRefreshMs: 0,
      testing: {
        resolve: async (name) => {
          if (name === "db.example.net." && !available) throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
          return [{ address: name === "db.example.net." ? "20.1.2.3" : "93.184.216.34", family: 4 }];
        },
      },
    });
    const paused = await refusal(filter.vet("https://example.com/"));
    expect([paused.code, paused.message]).toEqual(["internal", "This deployment's internal endpoints could not be resolved yet, so outbound requests are paused."]);
    available = true;
    expect((await filter.vet("https://example.com/")).addresses[0]!.address).toBe("93.184.216.34");
    available = false;
    expect((await refusal(filter.vet("http://20.1.2.3:5432/"))).code).toBe("internal");
  });

  it("applies the development exception only to loopback, private, shared, and unique-local addresses", async () => {
    const { filter } = harness(
      { "dev.example": ["10.1.1.1"], "ula.example": ["fd12::1"], localhost: ["127.0.0.1", "::1"], "mcp-dev": ["172.18.0.4"] },
      { internal: [{ host: "127.0.0.1", port: 5123 }, { host: "localhost", port: 5124 }] },
    );
    const options = { allowPrivateNetwork: true };
    expect((await filter.vet("http://127.0.0.1:9000/mcp", options)).addresses[0]!.category).toBe("loopback");
    expect((await filter.vet("http://localhost:9000/mcp", options)).addresses.map((entry) => entry.category)).toEqual(["loopback", "loopback"]);
    expect((await filter.vet("http://mcp-dev:8000/mcp", options)).addresses[0]!.category).toBe("private");
    expect((await filter.vet("http://dev.example/mcp", options)).addresses[0]!.category).toBe("private");
    expect((await filter.vet("http://ula.example/mcp", options)).addresses[0]!.category).toBe("unique-local");
    expect((await filter.vet("http://100.64.0.1/", options)).addresses[0]!.category).toBe("shared");
    for (const url of ["http://169.254.169.254/", "http://[fe80::1]/", "http://0.0.0.0/", "http://[::ffff:127.0.0.1]/", "http://224.0.0.1/", "http://168.63.129.16/"]) {
      expect((await refusal(filter.vet(url, options))).code).toBe("address");
    }
    expect((await refusal(filter.vet("http://127.0.0.1:5123/", options))).code).toBe("internal");
    expect((await refusal(filter.vet("http://localhost:5123/", options))).code).toBe("internal");
    expect((await refusal(filter.vet("http://localhost:5124/", options))).code).toBe("internal");
    expect((await refusal(filter.vet("http://localhost:9000/"))).code).toBe("hostname");
  });

  it("derives internal endpoints from Aspire service discovery and connection strings", () => {
    expect(internalEndpointsFromEnvironment({
      "services__job-dispatcher__http__0": "http://localhost:5123",
      "services__inference-gateway__https__0": "https://inference-gateway.internal.example.net",
      services__api__http__1: "http://[::1]:7000/",
      ConnectionStrings__jobsdb: "Host=db.example.net;Port=6543;Username=app;Password=not-a-real-password;Database=jobs",
      ConnectionStrings__cache: "redis://cache.example.net:6380",
      ConnectionStrings__multi: "Server=a.example.net:1433,b.example.net",
      UNRELATED_URL: "https://api.github.com",
    })).toEqual([
      { host: "localhost", port: 5123 },
      { host: "inference-gateway.internal.example.net", port: 443 },
      { host: "::1", port: 7000 },
      { host: "db.example.net", port: 6543 },
      { host: "cache.example.net", port: 6380 },
      { host: "a.example.net", port: 1433 },
      { host: "b.example.net" },
    ]);
  });

  it("validates redirect locations: HTTP(S) only, no downgrade, no credentials, bounded length", () => {
    const current = new URL("https://example.com/a/b");
    expect(resolveRedirect(current, "../c?x=1#frag").href).toBe("https://example.com/c?x=1");
    expect(resolveRedirect(new URL("http://example.com/"), "https://example.com/secure").protocol).toBe("https:");
    for (const [location, code] of [
      ["http://example.com/", "redirect"], ["file:///etc/passwd", "redirect"], ["ftp://example.com/", "redirect"],
      ["https://user:pw@example.com/", "credentials_in_url"], [`/${"a".repeat(5000)}`, "redirect"], ["http://[::1", "redirect"],
    ] as const) {
      let caught: unknown;
      try { resolveRedirect(current, location); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EgressError);
      expect((caught as EgressError).code).toBe(code);
    }
  });
});

describe("filtered requests", () => {
  it("pins the connection to the vetted address: a rebinding resolver is consulted once per hop", async () => {
    const hosts: string[] = [];
    const port = await serve((request, response) => {
      hosts.push(String(request.headers.host));
      response.writeHead(200, { "content-type": "text/plain" }).end("pinned");
    });
    let calls = 0;
    const dials: string[] = [];
    const filter = new EgressFilter({
      testing: {
        resolve: async () => (++calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
        dial: (address) => {
          dials.push(address.address);
          return { address: "127.0.0.1", family: 4 };
        },
      },
    });
    const response = await filter.request({ url: `http://rebind.example:${port}/`, maxResponseBytes: 1024, timeoutMs: 5000 });
    expect((await response.bytes()).toString()).toBe("pinned");
    expect(calls).toBe(1);
    expect(dials).toEqual(["93.184.216.34"]);
    expect(hosts).toEqual([`rebind.example:${port}`]);
  });

  it("rechecks every redirect hop and refuses metadata, loopback, private, and mapped targets", async () => {
    const seen: string[] = [];
    const port = await serve((request, response) => {
      seen.push(`${request.headers.host}${request.url}`);
      const target = new URL(request.url!, "http://x").searchParams.get("to");
      if (target) response.writeHead(302, { location: target }).end();
      else response.writeHead(200).end("final");
    });
    const { filter, dials } = harness({ "public.example": ["93.184.216.34"], "inside.example": ["10.0.0.5"], "hop.example": ["93.184.216.35"] });
    for (const [target, code, category] of [
      ["http://169.254.169.254/latest/meta-data/iam/", "address", "metadata"],
      ["http://0xA9FEA9FE/", "address", "metadata"],
      ["http://[fd00:ec2::254]/", "address", "metadata"],
      [`http://127.0.0.1:${port}/`, "address", "loopback"],
      [`http://localhost:${port}/`, "hostname", undefined],
      [`http://inside.example:${port}/`, "address", "private"],
      [`http://[::ffff:7f00:1]:${port}/`, "address", "ipv4-mapped"],
      ["file:///etc/passwd", "redirect", undefined],
    ] as const) {
      const error = await refusal(filter.request({
        url: `http://public.example:${port}/start?to=${encodeURIComponent(target)}`, maxRedirects: 5, maxResponseBytes: 1024, timeoutMs: 5000,
      }));
      expect([error.code, error.category]).toEqual([code, category]);
      expect(error.message).not.toMatch(/169\.254|127\.0\.0\.1|10\.0\.0\.5|fd00/);
    }
    expect(dials.every((address) => address.startsWith("93.184.216."))).toBe(true);
    expect(seen.every((entry) => entry.startsWith(`public.example:${port}/start`))).toBe(true);
    const followed: string[] = [];
    const response = await filter.request({
      url: `http://public.example:${port}/start?to=${encodeURIComponent(`http://hop.example:${port}/next`)}`,
      maxRedirects: 5, maxResponseBytes: 1024, timeoutMs: 5000,
      onRedirect: (from, to) => { followed.push(`${from.host}->${to.host}`); },
    });
    expect(response.url.href).toBe(`http://hop.example:${port}/next`);
    expect((await response.bytes()).toString()).toBe("final");
    expect(followed).toEqual([`public.example:${port}->hop.example:${port}`]);
  });

  it("refuses redirects by default, beyond the limit, and for non-GET requests; a refusing onRedirect stops the hop", async () => {
    const hits: string[] = [];
    const port = await serve((request, response) => {
      hits.push(request.url!);
      const step = Number(new URL(request.url!, "http://x").searchParams.get("n") ?? "0");
      response.writeHead(307, { location: `/loop?n=${step + 1}` }).end();
    });
    const { filter } = harness({ "public.example": ["93.184.216.34"], "other.example": ["93.184.216.36"] });
    const url = `http://public.example:${port}/loop?n=0`;
    expect((await refusal(filter.request({ url, maxResponseBytes: 1024, timeoutMs: 5000 }))).message).toMatch(/does not follow/);
    expect((await refusal(filter.request({ url, maxRedirects: 3, maxResponseBytes: 1024, timeoutMs: 5000 }))).message).toMatch(/more than 3/);
    expect((await refusal(filter.request({ url, method: "POST", body: "{}", maxRedirects: 3, maxResponseBytes: 1024, timeoutMs: 5000 }))).message).toMatch(/Only GET/);
    class Stop extends Error {}
    await expect(filter.request({
      url, maxRedirects: 3, maxResponseBytes: 1024, timeoutMs: 5000, onRedirect: () => { throw new Stop("not approved"); },
    })).rejects.toBeInstanceOf(Stop);
  });

  it("never sends credentials after a redirect, even to the same origin, and requires HTTPS for credentials to public hosts", async () => {
    const received: Array<string | undefined> = [];
    const port = await serve((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/start") response.writeHead(302, { location: `http://other.example:${port}/landing` }).end();
      else if (request.url === "/same") response.writeHead(302, { location: "/landing" }).end();
      else response.writeHead(200).end("ok");
    });
    const { filter } = harness({ "public.example": ["93.184.216.34"], "other.example": ["93.184.216.36"] });
    for (const header of ["Authorization", "cookie", "Proxy-Authorization", "X-Api-Key", "x-auth-token"]) {
      await expect(filter.request({ url: `http://public.example:${port}/`, headers: { [header]: "value" }, maxResponseBytes: 1024, timeoutMs: 5000 }))
        .rejects.toThrow(/in credentials, not headers/);
    }
    const insecure = await refusal(filter.request({
      url: `http://public.example:${port}/start`, credentials: { authorization: "Bearer test-credential-123" }, maxRedirects: 2, maxResponseBytes: 1024, timeoutMs: 5000,
    }));
    expect(insecure.code).toBe("insecure_credentials");
    expect(received).toEqual([]);
    const local = await serve((request, response) => {
      received.push(request.headers.authorization);
      if (request.url === "/start") response.writeHead(302, { location: "/landing" }).end();
      else response.writeHead(200).end("ok");
    });
    const devFilter = new EgressFilter();
    const response = await devFilter.request({
      url: `http://127.0.0.1:${local}/start`, credentials: { authorization: "Bearer test-credential-123" }, allowPrivateNetwork: true,
      maxRedirects: 2, maxResponseBytes: 1024, timeoutMs: 5000,
    });
    expect((await response.bytes()).toString()).toBe("ok");
    expect(received).toEqual(["Bearer test-credential-123", undefined]);
    expect((await refusal(new EgressFilter().request({ url: `http://127.0.0.1:${local}/start`, maxResponseBytes: 1024, timeoutMs: 5000 }))).category).toBe("loopback");
  });

  it("does not carry the development exception to another origin through a redirect", async () => {
    const other = await serve((_request, response) => { response.writeHead(200).end("other"); });
    const port = await serve((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${other}/` }).end(); });
    const error = await refusal(new EgressFilter().request({
      url: `http://127.0.0.1:${port}/`, allowPrivateNetwork: true, maxRedirects: 2, maxResponseBytes: 1024, timeoutMs: 5000,
    }));
    expect(error.category).toBe("loopback");
  });

  it("forwards only non-sensitive generic headers after a redirect", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const port = await serve((request, response) => {
      seen.push({ accept: request.headers.accept, trace: request.headers["x-trace"], session: request.headers["mcp-session-id"] });
      if (request.url === "/start") response.writeHead(302, { location: "/landing" }).end();
      else response.writeHead(200).end("ok");
    });
    const { filter } = harness({ "public.example": ["93.184.216.34"] });
    const response = await filter.request({
      url: `http://public.example:${port}/start`, headers: { accept: "text/plain", "x-trace": "abc", "mcp-session-id": "session-1" },
      maxRedirects: 1, maxResponseBytes: 1024, timeoutMs: 5000,
    });
    await response.bytes();
    expect(seen).toEqual([
      { accept: "text/plain", trace: "abc", session: "session-1" },
      { accept: "text/plain", trace: undefined, session: undefined },
    ]);
  });

  it("bounds response size before and after decompression, truncating only when asked", async () => {
    const port = await serve((request, response) => {
      if (request.url === "/declared") response.writeHead(200, { "content-length": "4096" }).end("x".repeat(4096));
      else if (request.url === "/chunked") {
        response.writeHead(200);
        for (let index = 0; index < 64; index++) response.write("y".repeat(1024));
        response.end();
      } else if (request.url === "/bomb") response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(10 * 1024 * 1024)));
      else if (request.url === "/gzip") response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("compressed text"));
      else response.writeHead(200, { "content-encoding": "zstd-unknown" }).end("??");
    });
    const { filter } = harness({ "public.example": ["93.184.216.34"] });
    const base = `http://public.example:${port}`;
    expect((await refusal(filter.request({ url: `${base}/declared`, maxResponseBytes: 1024, timeoutMs: 5000 }))).code).toBe("too_large");
    const chunked = await filter.request({ url: `${base}/chunked`, maxResponseBytes: 1024, timeoutMs: 5000 });
    expect((await refusal(chunked.bytes())).code).toBe("too_large");
    const truncated = await filter.request({ url: `${base}/chunked`, maxResponseBytes: 1500, overflow: "truncate", timeoutMs: 5000 });
    expect((await truncated.bytes()).length).toBe(1500);
    expect(truncated.truncated).toBe(true);
    const bomb = await filter.request({ url: `${base}/bomb`, maxResponseBytes: 64 * 1024, timeoutMs: 5000 });
    expect((await refusal(bomb.bytes())).code).toBe("too_large");
    expect((await (await filter.request({ url: `${base}/gzip`, maxResponseBytes: 1024, timeoutMs: 5000 })).bytes()).toString()).toBe("compressed text");
    expect((await refusal(filter.request({ url: `${base}/unknown`, maxResponseBytes: 1024, timeoutMs: 5000 }))).code).toBe("encoding");
  });

  it("enforces one deadline across headers and body, honours cancellation, and hides native network errors", async () => {
    const port = await serve((request, response) => {
      if (request.url === "/silent") return;
      response.writeHead(200);
      response.write("first");
    });
    const { filter } = harness({ "public.example": ["93.184.216.34"] });
    const started = Date.now();
    expect((await refusal(filter.request({ url: `http://public.example:${port}/silent`, maxResponseBytes: 1024, timeoutMs: 300 }))).code).toBe("timeout");
    const trickle = await filter.request({ url: `http://public.example:${port}/trickle`, maxResponseBytes: 1024, timeoutMs: 300 });
    expect((await refusal(trickle.bytes())).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
    const controller = new AbortController();
    const pending = filter.request({ url: `http://public.example:${port}/silent`, maxResponseBytes: 1024, timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    expect((await refusal(pending)).code).toBe("aborted");
    const closed = await serve(() => undefined);
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const refused = await refusal(new EgressFilter().request({ url: `http://127.0.0.1:${closed}/`, allowPrivateNetwork: true, maxResponseBytes: 1024, timeoutMs: 5000 }));
    expect(refused.code).toBe("network");
    expect(refused.message).not.toContain("127.0.0.1");
    expect(refused.message).not.toContain(String(closed));
  });
});
