'use strict';
// Finds pool controller servers on this machine and the local network by asking
// localhost and every address in each attached IPv4 subnet for GET /system/info.
//
//   node tools/find-servers.js                          scan the local subnets on port 3000
//   node tools/find-servers.js --port 8080              scan another port
//   node tools/find-servers.js --subnet 10.0.1.0/24     scan just a given subnet instead
//   node tools/find-servers.js --timeout 3000           wait longer for slow hosts (milliseconds)
//
// Exits 0 when it finds at least one server and 1 when it finds none.
const os = require('os');

const API_BASE = '/rhbroberg/pool-api/1.0.0';
const SERVICE_NAME = 'pool-controller';
// larger subnets would take minutes; those scan just the /24 around this machine
const MAX_HOSTS = 1024;

var argValue = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? fallback : process.argv[index + 1];
};

const port = Number(argValue('--port', 3000));
const timeoutMs = Number(argValue('--timeout', 1500));
const concurrency = Number(argValue('--concurrency', 128));

var toInt = (address) => address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
var toAddress = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
var maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
var prefixOf = (netmask) => toInt(netmask).toString(2).replace(/0/g, '').length;

var subnet = (address, prefix, name) => {
    if (prefix < 32 && 2 ** (32 - prefix) - 2 > MAX_HOSTS) {
        console.log(`${name}: ${toAddress(toInt(address) & maskOf(prefix))}/${prefix} is too large; scanning the /24 around ${address}`);
        prefix = 24;
    }
    const network = (toInt(address) & maskOf(prefix)) >>> 0;
    return { name, network, prefix, cidr: `${toAddress(network)}/${prefix}` };
};

var hostsIn = ({ network, prefix }) => {
    if (prefix >= 31) {
        return [network, (network | ~maskOf(prefix)) >>> 0].map(toAddress);
    }
    const hosts = [];
    const broadcast = (network | ~maskOf(prefix)) >>> 0;
    for (let n = network + 1; n < broadcast; n++) {
        hosts.push(toAddress(n));
    }
    return hosts;
};

var localSubnets = () => {
    const subnets = new Map();
    Object.entries(os.networkInterfaces()).forEach(([name, addresses]) => {
        addresses
            .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
            .forEach((a) => {
                const found = subnet(a.address, prefixOf(a.netmask), name);
                if (!subnets.has(found.cidr)) {
                    subnets.set(found.cidr, found);
                }
            });
    });
    return [...subnets.values()];
};

var givenSubnet = (cidr) => {
    const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr || '');
    if (!match || Number(match[2]) > 32) {
        console.error(`--subnet wants an address and prefix like 192.168.1.0/24, not ${cidr}`);
        process.exit(2);
    }
    return subnet(match[1], Number(match[2]), 'given');
};

var probe = async (host) => {
    try {
        const response = await fetch(`http://${host}:${port}${API_BASE}/system/info`, {
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
            return undefined;
        }
        const info = await response.json();
        return info && info.service === SERVICE_NAME ? { host, ...info } : undefined;
    } catch {
        return undefined;
    }
};

var scan = async (hosts) => {
    const found = [];
    let next = 0;
    const worker = async () => {
        while (next < hosts.length) {
            const result = await probe(hosts[next++]);
            if (result) {
                found.push(result);
                console.log(`  found http://${result.host}:${port}  version ${result.version}, up since ${result.startedAt}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    return found;
};

(async () => {
    const local = !process.argv.includes('--subnet');
    const subnets = local ? localSubnets() : [givenSubnet(argValue('--subnet'))];
    const hosts = [...new Set([...(local ? ['localhost'] : []), ...subnets.flatMap(hostsIn)])];
    const scanned = [...(local ? ['localhost'] : []), ...subnets.map((s) => `${s.cidr} (${s.name})`)];
    console.log(`scanning ${hosts.length} addresses in ${scanned.join(', ')} on port ${port}`);

    const started = Date.now();
    const found = await scan(hosts);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(found.length === 0
        ? `no pool controller servers found (${seconds}s)`
        : `found ${found.length} pool controller server${found.length === 1 ? '' : 's'} (${seconds}s)`);
    process.exit(found.length === 0 ? 1 : 0);
})();
