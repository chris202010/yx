// 新增页面明暗：浅色/深色/跟随系统
// 新增自定义数据源
// 新增CFnew版IP输出方式，方便一键复制
// 新增环境变量添加密码，且输出结果url不需要密码，方便引用
// 改变默认edgetunnel输出方式为纯节点，方便结合Sub Store使用
// 更改时间格式为24时制并新增年月日显示
// 增加了Token管理
// 新增CFnew自动更新引用url
// 自定义优质IP数量
// 新增优选订阅接口 (/sub) 含EdgeTunnel适配
// 新增IP地理位置信息显示
const FAST_IP_COUNT = 30; // 修改这个数字来自定义优质IP数量
const AUTO_TEST_MAX_IPS = 300; // 自动测速的最大IP数量，避免测速过多导致超时
const GEO_LOCATION_ENABLED = true; // 是否启用地理位置查询
const GEO_BATCH_SIZE = 3; // 地理位置查询并发数

export default {
async scheduled(event, env, ctx) {
console.log('Running scheduled IP update...');

try {
if (!env.IP_STORAGE) {
console.error('KV namespace IP_STORAGE is not bound');
return;
}

const startTime = Date.now();
const { uniqueIPs, results } = await updateAllIPs(env);
const duration = Date.now() - startTime;

await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
ips: uniqueIPs,
lastUpdated: new Date().toISOString(),
count: uniqueIPs.length,
sources: results
}));

// 自动触发测速并存储优质IP
await autoSpeedTestAndStore(env, uniqueIPs);

console.log(`Scheduled update: ${uniqueIPs.length} IPs collected in ${duration}ms`);
} catch (error) {
console.error('Scheduled update failed:', error);
}
},

async fetch(request, env, ctx) {
if (!env.password) {
return new Response('未配置password环境变量！', {
status: 500,
headers: { 'Content-Type': 'text/plain; charset=utf-8' }
});
}

const _authUrl = new URL(request.url);
const _clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

if (_authUrl.pathname === '/auth-login' && request.method === 'POST') {
return await handleLoginRequest(request, env, _clientIP);
}

// 新增：退出登录后端处理
if (_authUrl.pathname === '/auth-logout') {
return new Response(JSON.stringify({ success: true }), {
headers: {
'Content-Type': 'application/json',
'Set-Cookie': 'cf_ip_auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure'
}
});
}

const _cookie = request.headers.get('Cookie') || '';
const _isAuthorized = await verifyAuthCookie(_cookie, env.password);

if (!_isAuthorized && _authUrl.pathname !== '/edgetunnel.txt' && _authUrl.pathname !== '/cfnew.txt' && _authUrl.pathname !== '/cf-custom-port' && !_authUrl.pathname.startsWith('/sub')) {
return await serveAuthPage(env);
}


const url = new URL(request.url);
const path = url.pathname;

// 检查 KV 是否绑定
if (!env.IP_STORAGE) {
return new Response('KV namespace IP_STORAGE is not bound. Please bind it in Worker settings.', {
status: 500,
headers: { 'Content-Type': 'text/plain' }
});
}

if (request.method === 'OPTIONS') {
return handleCORS();
}

try {
switch (path) {
case '/':
return await serveHTML(env);
case '/update':
if (request.method !== 'POST') {
return jsonResponse({ error: 'Method not allowed' }, 405);
}
return await handleUpdate(env);
case '/ips':
return await handleGetIPs(env);
case '/ip.txt':
return await handleGetIPs(env);
case '/raw':
return await handleRawIPs(env);
case '/speedtest':
return await handleSpeedTest(request, env);
case '/itdog-data':
return await handleItdogData(env);
case '/fast-ips':
return await handleGetFastIPs(env);
case '/fast-ips.txt':
return await handleGetFastIPsText(env);
// 新增路由：EdgeTunnel版
case '/edgetunnel.txt':
return await handleGetEdgeTunnelIPs(request, env);
// 新增路由：CFNew版
case '/cfnew.txt':
return await handleGetCFNewIPs(request, env);
// 新增路由：自定义端口版
case '/cf-custom-port':
return await handleGetCFCustomPort(request, env);
// --- 新增路由：自定义来源 ---
case '/save-custom-source':
return await handleSaveCustomSource(request, env);
case '/get-custom-source':
return await handleGetCustomSource(env);
// --- 新增路由：删除自定义来源 ---
case '/delete-custom-source':
return await handleDeleteCustomSource(request, env);
// --- 新增：Token管理 ---
case '/admin-token':
return await handleAdminToken(request, env);
// --- 新增：优选订阅接口 ---
case '/sub':
return await handleSubscription(request, env);
default:
return jsonResponse({ error: 'Endpoint not found' }, 404);
}
} catch (error) {
console.error('Error:', error);
return jsonResponse({ error: error.message }, 500);
}
}
};


// ========== 优选订阅接口 ==========

async function handleSubscription(request, env) {
    const url = new URL(request.url);

    // Token门禁
    const tokenConfig = await getTokenConfig(env);
    if (tokenConfig && tokenConfig.token) {
        const tokenParam = url.searchParams.get('token');
        if (tokenParam !== tokenConfig.token) {
            return new Response('需要管理员权限', {
                status: 401,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    }

    const subType = detectSubType(url);
    const data = await getStoredSpeedIPs(env);
    const fastIPs = data.fastIPs || [];
    const uuid = env.UUID || 'e2e946b3-ad13-44ff-9cfa-ca3061d21f6a';
    const proxyIP = env.PROXY_IP || '';
    const sni = env.SNI || 'workers.cloudflare.com';
    const remark = env.SUB_REMARK || 'CF-Worker';
    const port = url.searchParams.get('port') || '443';

    if (fastIPs.length === 0) {
        return new Response('暂无优质IP数据，请先更新并测速', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    switch (subType) {
        case 'joey':
            return await generateJoeySubscription(fastIPs, port, remark);
        case 'cml':
            return await generateCMLSubscription(fastIPs, port, remark);
        case 'clash':
            return await generateClashSubscription(fastIPs, uuid, port, sni, remark);
        case 'base64':
            return await generateBase64Subscription(fastIPs, uuid, port, sni, proxyIP, remark);
        case 'vless':
            return await generateVLESSSubscription(fastIPs, uuid, port, sni, proxyIP, remark);
        case 'trojan':
            return await generateTrojanSubscription(fastIPs, uuid, port, sni, remark);
        case 'sni':
            return await generateSNISubscription(fastIPs, port, sni, remark);
        case 'edgetunnel':
            return await generateEdgeTunnelSubscription(request, fastIPs, remark);
        default:
            return await serveSubConsole(request, env, fastIPs, tokenConfig);
    }
}

function detectSubType(url) {
    const params = url.searchParams;
    const allTypes = ['joey', 'clash', 'base64', 'vless', 'trojan', 'cml', 'sni', 'edgetunnel'];
    for (const key of params.keys()) {
        if (allTypes.includes(key)) {
            return key;
        }
    }
    const type = params.get('type');
    if (type && allTypes.includes(type)) {
        return type;
    }
    const mode = params.get('mode');
    if (mode && allTypes.includes(mode)) {
        return mode;
    }
    // 自动检测：有host+uuid参数时识别为EdgeTunnel优选订阅生成器
    if (params.get('host') && params.get('uuid')) {
        return 'edgetunnel';
    }
    return '';
}

// 生成带国家地区信息的备注
function getNodeRemark(item, remark) {
    const loc = item.location;
    if (loc && loc.countryCode) {
        const codePoints = loc.countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
        const flag = String.fromCodePoint(...codePoints);
        const city = loc.city || loc.country || '';
        return remark + '\u00b7' + flag + ' ' + city;
    }
    return remark + '\u00b7' + item.ip;
}

// Joey/EdgeTunnel 格式: IP:端口#备注, 逗号分隔
async function generateJoeySubscription(fastIPs, port, remark) {
    const nodeList = fastIPs.map(item => `${item.ip}:${port}#${getNodeRemark(item, remark)}`).join(',');
    return new Response(nodeList, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'profile-update-interval': '24'
        }
    });
}

// CMLIU 格式: IP:端口#备注, 换行分隔
async function generateCMLSubscription(fastIPs, port, remark) {
    const nodeList = fastIPs.map(item => `${item.ip}:${port}#${getNodeRemark(item, remark)}`).join('\n');
    return new Response(nodeList, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'profile-update-interval': '24'
        }
    });
}

// SNI 格式: IP:端口@SNI#备注
async function generateSNISubscription(fastIPs, port, sni, remark) {
    const nodeList = fastIPs.map(item => `${item.ip}:${port}@${sni}#${getNodeRemark(item, remark)}`).join('\n');
    return new Response(nodeList, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'profile-update-interval': '24'
        }
    });
}

// EdgeTunnel 优选订阅生成器：兼容 CMLIU EdgeTunnel 的 优选订阅生成器 接口
// 请求格式: /sub?host=WORKER_DOMAIN&uuid=UUID [&path=/ &port=443]
// 返回: base64编码的vless链接，每行一个
async function generateEdgeTunnelSubscription(request, fastIPs, remark) {
    const url = new URL(request.url);
    const host = url.searchParams.get('host') || '';
    const uuid = url.searchParams.get('uuid') || '';
    const path = url.searchParams.get('path') || '/';
    const port = url.searchParams.get('port') || '443';

    if (!host || !uuid) {
        return new Response('缺少 host 或 uuid 参数', {
            status: 400,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }

    const nodeLinks = fastIPs.map(item => {
        return 'vless://' + uuid + '@' + item.ip + ':' + port +
            '?security=tls&type=ws&host=' + host + '&fp=chrome&sni=' + host +
            '&path=' + encodeURIComponent(path) + '&encryption=none#' +
            encodeURIComponent(getNodeRemark(item, remark));
    });
    const content = nodeLinks.join('\n');
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    return new Response(base64Content, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'profile-update-interval': '24'
        }
    });
}

// Base64 通用订阅 (VLESS + Trojan)
async function generateBase64Subscription(fastIPs, uuid, port, sni, proxyIP, remark) {
    const nodeLinks = [];
    fastIPs.forEach(item => {
        nodeLinks.push(`vless://${uuid}@${item.ip}:${port}?encryption=none&security=tls&sni=${sni}&fp=chrome&type=tcp${proxyIP ? '&proxyIP=' + proxyIP : ''}#${getNodeRemark(item, remark + '·VLESS')}`);
    });
    fastIPs.forEach(item => {
        nodeLinks.push(`trojan://${uuid}@${item.ip}:${port}?security=tls&sni=${sni}&fp=chrome&type=tcp#${getNodeRemark(item, remark + '·Trojan')}`);
    });
    const content = nodeLinks.join('\n');
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    return new Response(base64Content, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Subscription-Userinfo': `upload=0; download=0; total=10737418240000; expire=${Math.floor(Date.now() / 1000) + 86400 * 365}`,
            'profile-update-interval': '24'
        }
    });
}

// 纯VLESS订阅 (Base64)
async function generateVLESSSubscription(fastIPs, uuid, port, sni, proxyIP, remark) {
    const nodeLinks = fastIPs.map(item =>
        `vless://${uuid}@${item.ip}:${port}?encryption=none&security=tls&sni=${sni}&fp=chrome&type=tcp${proxyIP ? '&proxyIP=' + proxyIP : ''}#${getNodeRemark(item, remark)}`
    );
    const content = nodeLinks.join('\n');
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    return new Response(base64Content, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Subscription-Userinfo': `upload=0; download=0; total=10737418240000; expire=${Math.floor(Date.now() / 1000) + 86400 * 365}`,
            'profile-update-interval': '24'
        }
    });
}

// 纯Trojan订阅 (Base64)
async function generateTrojanSubscription(fastIPs, uuid, port, sni, remark) {
    const nodeLinks = fastIPs.map(item =>
        `trojan://${uuid}@${item.ip}:${port}?security=tls&sni=${sni}&fp=chrome&type=tcp#${getNodeRemark(item, remark)}`
    );
    const content = nodeLinks.join('\n');
    const base64Content = btoa(unescape(encodeURIComponent(content)));
    return new Response(base64Content, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Subscription-Userinfo': `upload=0; download=0; total=10737418240000; expire=${Math.floor(Date.now() / 1000) + 86400 * 365}`,
            'profile-update-interval': '24'
        }
    });
}

// Clash YAML 订阅格式
async function generateClashSubscription(fastIPs, uuid, port, sni, remark) {
    const proxies = [];
    const proxyNames = [];
    fastIPs.forEach(item => {
        const ip = item.ip;
        const shortIp = ip.split('.').slice(-2).join('.');
        const vlessName = `${getNodeRemark(item, remark + '·VL')}`;
        proxies.push(`  - name: "${vlessName}"
    type: vless
    server: ${ip}
    port: ${port}
    uuid: ${uuid}
    udp: true
    tls: true
    servername: ${sni}
    network: tcp
    client-fingerprint: chrome`);
        proxyNames.push(vlessName);
        const trojanName = `${getNodeRemark(item, remark + '·TR')}`;
        proxies.push(`  - name: "${trojanName}"
    type: trojan
    server: ${ip}
    port: ${port}
    password: ${uuid}
    udp: true
    sni: ${sni}
    client-fingerprint: chrome`);
        proxyNames.push(trojanName);
    });
    const yaml = `port: 7890
socks-port: 7891
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090

proxies:
${proxies.join('\n\n')}

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "♻️ 自动选择"
      - "🔯 故障转移"
      - "⚖️ 负载均衡"
${proxyNames.map(n => `      - "${n}"`).join('\n')}

  - name: "♻️ 自动选择"
    type: url-test
    proxies:
${proxyNames.map(n => `      - "${n}"`).join('\n')}
    url: "https://www.gstatic.com/generate_204"
    interval: 300
    tolerance: 50

  - name: "🔯 故障转移"
    type: fallback
    proxies:
${proxyNames.map(n => `      - "${n}"`).join('\n')}
    url: "https://www.gstatic.com/generate_204"
    interval: 300

  - name: "⚖️ 负载均衡"
    type: load-balance
    proxies:
${proxyNames.map(n => `      - "${n}"`).join('\n')}
    url: "https://www.gstatic.com/generate_204"
    interval: 300

  - name: "🎯 全球直连"
    type: select
    proxies:
      - DIRECT
      - "🚀 节点选择"

  - name: "🛑 全球拦截"
    type: select
    proxies:
      - REJECT
      - "🚀 节点选择"

  - name: "🐟 漏网之鱼"
    type: select
    proxies:
      - "🚀 节点选择"
      - "🎯 全球直连"

rules:
  - DOMAIN-SUFFIX,google.com,🚀 节点选择
  - DOMAIN-SUFFIX,youtube.com,🚀 节点选择
  - DOMAIN-SUFFIX,facebook.com,🚀 节点选择
  - DOMAIN-SUFFIX,twitter.com,🚀 节点选择
  - DOMAIN-SUFFIX,telegram.org,🚀 节点选择
  - DOMAIN-SUFFIX,github.com,🚀 节点选择
  - DOMAIN-KEYWORD,google,🚀 节点选择
  - GEOIP,CN,🎯 全球直连
  - MATCH,🐟 漏网之鱼
`;
    return new Response(yaml, {
        headers: {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Content-Disposition': 'inline; filename="clash_config.yaml"',
            'Access-Control-Allow-Origin': '*',
            'profile-update-interval': '24'
        }
    });
}

// 订阅控制台页面
async function serveSubConsole(request, env, fastIPs, tokenConfig) {
    const workerUrl = `https://${new URL(request.url).hostname}`;
    const tokenAnd = (tokenConfig && tokenConfig.token) ? `&token=${tokenConfig.token}` : '';
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>优选订阅接口</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0d0520 0%,#1a0a3e 40%,#0d1a3a 70%,#1a0520 100%);color:#f0e6ff;min-height:100vh;padding:24px}
.container{max-width:900px;margin:0 auto}
h1{font-size:28px;background:linear-gradient(135deg,#ff9de2,#c084fc,#67e8f9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
.subtitle{color:#a78bfa;font-size:14px;margin-bottom:32px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:#a78bfa;box-shadow:0 0 10px #a78bfa;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,180,220,.1);border-radius:18px;padding:20px;margin-bottom:16px;transition:all .3s}
.card:hover{background:rgba(255,180,220,.08);border-color:rgba(255,150,200,.3);transform:translateY(-2px)}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.badge{font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:.1em}
.badge-blue{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);color:#60a5fa}
.badge-purple{background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.2);color:#c084fc}
.badge-pink{background:rgba(236,72,153,.1);border:1px solid rgba(236,72,153,.2);color:#f472b6}
.badge-green{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#6ee7b7}
.badge-orange{background:rgba(249,115,22,.1);border:1px solid rgba(249,115,22,.2);color:#fb923c}
.badge-cyan{background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.2);color:#67e8f9}
.badge-red{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:#f87171}
.desc{font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:14px}
.desc strong{color:#e2e8f0}
.url-box{background:rgba(0,0,0,.3);border:1px solid rgba(255,180,220,.1);border-radius:10px;padding:10px 14px;font-family:'Fira Code',monospace;font-size:12px;color:#c084fc;word-break:break-all;margin-bottom:12px;user-select:all}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .2s}
.btn-blue{background:#3b82f6;color:#fff}
.btn-purple{background:#9333ea;color:#fff}
.btn-pink{background:#db2777;color:#fff}
.btn-green{background:#059669;color:#fff}
.btn-orange{background:#ea580c;color:#fff}
.btn-cyan{background:#0891b2;color:#fff}
.btn-red{background:#dc2626;color:#fff}
.btn:hover{opacity:.85;transform:translateY(-1px)}
.stats{display:flex;gap:20px;margin-bottom:24px;flex-wrap:wrap}
.stat-item{background:rgba(255,255,255,.04);border:1px solid rgba(255,180,220,.1);border-radius:12px;padding:16px 20px;text-align:center;flex:1;min-width:120px}
.stat-value{font-size:28px;font-weight:900;background:linear-gradient(135deg,#ff9de2,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-label{font-size:11px;color:#a78bfa;margin-top:4px}
.footer{text-align:center;margin-top:32px;padding-top:20px;border-top:1px solid rgba(255,150,200,.08);color:#64748b;font-size:12px}
@media(max-width:640px){.stats{flex-direction:column}.btn-row{flex-direction:column}.btn{width:100%;justify-content:center}}
</style>
</head>
<body>
<div class="container">
<h1>🌸 优选订阅接口</h1>
<div class="subtitle"><span class="dot"></span> 系统运行中 · ${fastIPs.length} 个优质IP可用</div>

<div class="stats">
<div class="stat-item"><div class="stat-value">${fastIPs.length}</div><div class="stat-label">优质IP数量</div></div>
<div class="stat-item"><div class="stat-value">8</div><div class="stat-label">接口类型</div></div>
<div class="stat-item"><div class="stat-value">24h</div><div class="stat-label">自动更新</div></div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-blue">EdgeTunnel / Joey 专用</span></div>
<div class="desc">进入 <strong>Joey项目后台</strong> → 延迟测试 → URL获取 → 粘贴接口URL</div>
<div class="url-box">${workerUrl}/sub?joey${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-blue" onclick="copy('${workerUrl}/sub?joey${tokenAnd}')">📋 复制 Joey 接口</button>
<a href="/sub?joey${tokenAnd}" target="_blank" class="btn btn-blue" style="text-decoration:none">🔗 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-purple">CMLIU 订阅接口</span></div>
<div class="desc">进入 <strong>cmliu项目后台</strong> → 优选订阅生成 → 粘贴接口URL</div>
<div class="url-box">${workerUrl}/sub?cml${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-purple" onclick="copy('${workerUrl}/sub?cml${tokenAnd}')">📋 复制 CMLIU 接口</button>
<a href="/sub?cml${tokenAnd}" target="_blank" class="btn btn-purple" style="text-decoration:none">🔗 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-pink">SNI 接口</span></div>
<div class="desc">改写代码时替换 <strong>上游订阅器位置</strong>，格式: IP:端口@SNI#备注</div>
<div class="url-box">${workerUrl}/sub?sni${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-pink" onclick="copy('${workerUrl}/sub?sni${tokenAnd}')">📋 复制 SNI 接口</button>
<a href="/sub?sni${tokenAnd}" target="_blank" class="btn btn-pink" style="text-decoration:none">🔗 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-green">Base64 通用订阅</span></div>
<div class="desc">适用于 <strong>V2Ray / Shadowrocket / Quantumult X</strong> 等客户端，包含VLESS+Trojan节点</div>
<div class="url-box">${workerUrl}/sub?base64${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-green" onclick="copy('${workerUrl}/sub?base64${tokenAnd}')">📋 复制订阅链接</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-orange">VLESS 订阅</span></div>
<div class="desc">纯 <strong>VLESS</strong> 节点 Base64 订阅，适配 EdgeTunnel/Sub Store</div>
<div class="url-box">${workerUrl}/sub?vless${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-orange" onclick="copy('${workerUrl}/sub?vless${tokenAnd}')">📋 复制 VLESS 订阅</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-cyan">Trojan 订阅</span></div>
<div class="desc">纯 <strong>Trojan</strong> 节点 Base64 订阅</div>
<div class="url-box">${workerUrl}/sub?trojan${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-cyan" onclick="copy('${workerUrl}/sub?trojan${tokenAnd}')">📋 复制 Trojan 订阅</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-blue">Clash 订阅</span></div>
<div class="desc">适用于 <strong>Clash / ClashX / Clash for Windows</strong>，包含自动选择/故障转移/负载均衡策略组</div>
<div class="url-box">${workerUrl}/sub?clash${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-blue" onclick="copy('${workerUrl}/sub?clash${tokenAnd}')">📋 复制 Clash 订阅</button>
<a href="/sub?clash${tokenAnd}" target="_blank" class="btn btn-blue" style="text-decoration:none">🔗 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-red">EdgeTunnel 优选订阅生成器</span></div>
<div class="desc">适配 <strong>CMLIU EdgeTunnel</strong> 的优选订阅生成器接口，在 EdgeTunnel 中设置 BEST_SUB 环境变量为此URL</div>
<div class="url-box">${workerUrl}/sub?host=WORKER域名&uuid=你的UUID${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-red" onclick="copy('${workerUrl}/sub?host=WORKER域名&uuid=你的UUID${tokenAnd}')">📋 复制 EdgeTunnel 接口</button>
</div>
</div>

<div class="footer"><p>Cloudflare Worker BestIP Collector · 优选订阅服务</p></div>
</div>
<script>
function copy(text){navigator.clipboard.writeText(text).then(()=>{const t=document.createElement('div');t.textContent='✅ 已复制';t.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(59,130,246,.9);color:#fff;padding:10px 24px;border-radius:30px;font-size:13px;font-weight:700;z-index:9999;box-shadow:0 5px 15px rgba(0,0,0,.3)';document.body.appendChild(t);setTimeout(()=>t.remove(),1500)});}
</script>
</body>
</html>`;
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}


// ========== 提供HTML页面 ==========
async function serveHTML(env) {
const data = await getStoredIPs(env);

// 获取测速后的IP数据
const speedData = await getStoredSpeedIPs(env);
const fastIPs = speedData.fastIPs || [];
// --- 新增：获取Token配置 ---
const tokenConfig = await getTokenConfig(env);
const tokenParam = (tokenConfig && tokenConfig.token) ? `?token=${tokenConfig.token}` : '';
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<link rel="icon" href="https://raw.githubusercontent.com/alienwaregf/personal-use/refs/heads/main/image/Favicon/GF.svg" type="image/svg+xml">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloudflare IP 收集器</title>
<style>
* {
margin: 0;
padding: 0;
box-sizing: border-box;
}

:root {
--bg-color: #f8fafc;
--text-color: #334155;
--card-bg: white;
--card-border: #e2e8f0;
--stat-bg: #f8fafc;
--ip-list-bg: #f8fafc;
--hover-bg: #f1f5f9;
--modal-bg: white;
--location-bg: #f0f9ff;
--location-text: #0c4a6e;
}

body.dark-mode {
--bg-color: #0f172a;
--text-color: #cbd5e1;
--card-bg: #1e293b;
--card-border: #334155;
--stat-bg: #334155;
--ip-list-bg: #0f172a;
--hover-bg: #334155;
--modal-bg: #1e293b;
--location-bg: #0c4a6e;
--location-text: #bae6fd;
}

body {
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
line-height: 1.6;
background: var(--bg-color);
color: var(--text-color);
min-height: 100vh;
padding: 20px;
transition: background 0.3s, color 0.3s;
}

.container {
max-width: 1200px;
margin: 0 auto;
}

.header {
display: flex;
justify-content: space-between;
align-items: center;
margin-bottom: 40px;
padding-bottom: 20px;
border-bottom: 1px solid var(--card-border);
}

.header-content h1 {
font-size: 2.5rem;
background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
margin-bottom: 8px;
font-weight: 700;
}

.header-content p {
color: #64748b;
font-size: 1.1rem;
}

.social-links {
display: flex;
gap: 15px;
align-items: center;
}

.social-link, .theme-toggle {
display: flex;
align-items: center;
justify-content: center;
width: 44px;
height: 44px;
border-radius: 12px;
background: var(--card-bg);
border: 1px solid var(--card-border);
transition: all 0.3s ease;
text-decoration: none;
box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
cursor: pointer;
color: var(--text-color);
}

.social-link svg {
display: block;
}

.social-link:hover, .theme-toggle:hover {
background: var(--hover-bg);
transform: translateY(-2px);
border-color: #cbd5e1;
box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

.social-link.youtube { color: #dc2626; }
.social-link.youtube:hover { background: #fef2f2; border-color: #fecaca; }
.social-link.github { color: var(--text-color); }
.social-link.github:hover { background: var(--hover-bg); border-color: #cbd5e1; }
.social-link.telegram { color: #3b82f6; }
.social-link.telegram:hover { background: #eff6ff; border-color: #bfdbfe; }

.theme-toggle svg {
fill: none;
stroke: currentColor;
stroke-width: 2;
stroke-linecap: round;
stroke-linejoin: round;
}

.card {
background: var(--card-bg);
border-radius: 16px;
padding: 30px;
margin-bottom: 24px;
border: 1px solid var(--card-border);
box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
}

.card h2 {
font-size: 1.5rem;
color: #3b82f6;
margin-bottom: 20px;
font-weight: 600;
}

.stats {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
gap: 16px;
margin-bottom: 24px;
}

.stat {
background: var(--stat-bg);
padding: 20px;
border-radius: 12px;
text-align: center;
border: 1px solid var(--card-border);
}

.stat-value {
font-size: 2rem;
font-weight: 700;
color: #3b82f6;
margin-bottom: 8px;
}

.stat-date {
font-size: 0.9rem;
color: #64748b;
margin-bottom: 4px;
}

.button-group {
display: flex;
flex-wrap: wrap;
gap: 12px;
margin-bottom: 20px;
}

.button {
padding: 12px 20px;
border: none;
border-radius: 10px;
font-size: 0.95rem;
font-weight: 600;
cursor: pointer;
transition: all 0.3s ease;
text-decoration: none;
display: inline-flex;
align-items: center;
gap: 8px;
background: #3b82f6;
color: white;
border: 1px solid #3b82f6;
}

.button:hover {
transform: translateY(-1px);
box-shadow: 0 4px 8px rgba(59, 130, 246, 0.3);
}

.button:disabled {
opacity: 0.6;
cursor: not-allowed;
transform: none;
box-shadow: none;
}

.button-success { background: #10b981; border-color: #10b981; }
.button-success:hover { background: #059669; border-color: #059669; }

.button-warning { background: #f59e0b; border-color: #f59e0b; }
.button-warning:hover { background: #d97706; border-color: #d97706; }

.button-secondary { background: var(--card-bg); color: var(--text-color); border-color: var(--card-border); }
.button-secondary:hover { background: var(--hover-bg); border-color: #94a3b8; }

.button-edgetunnel {
background-color: #374151;
color: #f97316;
border: 1px solid #f97316;
}
.button-edgetunnel:hover {
background-color: #1f2937;
box-shadow: 0 4px 8px rgba(249, 115, 22, 0.2);
}

.button-cfnew {
background-color: #000000;
color: #00ff00;
border: 1px solid #00ff00;
text-shadow: 0 0 5px #00ff00;
box-shadow: 0 0 5px rgba(0, 255, 0, 0.3);
}

.button-cfnew:hover {
background-color: #0a0a0a;
box-shadow: 0 0 15px rgba(0, 255, 0, 0.6);
}

.button-sub {
background-color: #7c3aed;
color: #fff;
border: 1px solid #a78bfa;
}
.button-sub:hover {
background-color: #6d28d9;
box-shadow: 0 4px 8px rgba(124, 58, 237, 0.3);
}

.dropdown {
position: relative;
display: inline-block;
}

.dropdown::after {
content: '';
position: absolute;
top: 100%;
left: 0;
width: 100%;
height: 10px;
}

.dropdown-content {
display: none;
position: absolute;
background-color: var(--card-bg);
min-width: 160px;
box-shadow: 0 8px 16px 0 rgba(0,0,0,0.2);
z-index: 100;
border-radius: 10px;
border: 1px solid var(--card-border);
overflow: hidden;
top: 100%;
left: 50%;
transform: translateX(-50%);
margin-top: 5px;
}

.dropdown-content a {
color: var(--text-color);
padding: 12px 16px;
text-decoration: none;
display: block;
border-bottom: 1px solid var(--card-border);
transition: all 0.3s ease;
text-align: center;
cursor: pointer;
}

.dropdown-content a:hover {
background-color: var(--hover-bg);
color: #3b82f6;
}

.dropdown-content a:last-child {
border-bottom: none;
}

.dropdown:hover .dropdown-content {
display: block;
}

.dropdown-btn {
display: flex;
align-items: center;
gap: 4px;
}

.ip-list-header {
display: flex;
justify-content: space-between;
align-items: center;
margin-bottom: 20px;
flex-wrap: wrap;
gap: 15px;
}

.ip-list {
background: var(--ip-list-bg);
border-radius: 12px;
padding: 20px;
max-height: 500px;
overflow-y: auto;
border: 1px solid var(--card-border);
}

.ip-item {
display: flex;
justify-content: space-between;
align-items: center;
padding: 12px 16px;
border-bottom: 1px solid var(--card-border);
transition: background 0.3s ease;
}

.ip-item:hover {
background: var(--hover-bg);
}

.ip-item:last-child {
border-bottom: none;
}

.ip-info {
display: flex;
align-items: center;
gap: 16px;
}

.ip-address {
font-family: 'SF Mono', 'Courier New', monospace;
font-weight: 600;
min-width: 140px;
color: var(--text-color);
}

.ip-location {
font-size: 0.8rem;
padding: 4px 10px;
border-radius: 6px;
background: var(--location-bg);
color: var(--location-text);
font-weight: 500;
white-space: nowrap;
max-width: 200px;
overflow: hidden;
text-overflow: ellipsis;
border: 1px solid var(--card-border);
display: flex;
align-items: center;
gap: 4px;
}

.ip-location.loading-location {
animation: locationPulse 1.5s ease-in-out infinite;
background: var(--stat-bg);
color: #94a3b8;
}

@keyframes locationPulse {
0%, 100% { opacity: 1; }
50% { opacity: 0.5; }
}

.speed-result {
font-size: 0.85rem;
padding: 4px 12px;
border-radius: 8px;
background: #e2e8f0;
min-width: 70px;
text-align: center;
font-weight: 600;
color: #334155;
}

.speed-fast { background: #d1fae5; color: #065f46; }
.speed-medium { background: #fef3c7; color: #92400e; }
.speed-slow { background: #fee2e2; color: #991b1b; }

.source-tag {
font-size: 0.75rem;
padding: 2px 8px;
border-radius: 4px;
background: #e2e8f0;
color: #475569;
}

body.dark-mode .source-tag {
background: #334155;
color: #94a3b8;
}

.modal {
display: none;
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.5);
backdrop-filter: blur(4px);
z-index: 1000;
justify-content: center;
align-items: center;
}

.modal-content {
background: var(--modal-bg);
padding: 30px;
border-radius: 16px;
width: 90%;
max-width: 500px;
border: 1px solid var(--card-border);
box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
position: relative;
}

.modal-close {
position: absolute;
top: 20px;
right: 20px;
background: none;
border: none;
font-size: 1.5rem;
cursor: pointer;
color: #64748b;
}

.form-group {
margin-bottom: 20px;
}

.form-group label {
display: block;
margin-bottom: 8px;
font-weight: 600;
font-size: 0.95rem;
}

.form-control {
width: 100%;
padding: 10px 14px;
border: 1px solid var(--card-border);
border-radius: 8px;
background: var(--bg-color);
color: var(--text-color);
font-size: 0.95rem;
}

.form-control:focus {
outline: none;
border-color: #3b82f6;
box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
}

.source-item {
display: flex;
justify-content: space-between;
align-items: center;
padding: 10px;
border: 1px solid var(--card-border);
border-radius: 8px;
margin-bottom: 8px;
background: var(--bg-color);
}

.source-name { font-weight: 600; font-size: 0.9rem;}
.source-url { font-size: 0.8rem; color:#64748b; word-break: break-all; max-width: 70%;}
.btn-delete { background:#ef4444; color:white; padding:4px 8px; border:none; border-radius:4px; font-size:0.8rem; cursor:pointer;}
.btn-delete:hover { background:#dc2626;}

.footer {
text-align: center;
margin-top: 40px;
color: #64748b;
font-size: 0.9rem;
padding-top: 20px;
border-top: 1px solid var(--card-border);
}

#toast {
visibility: hidden;
min-width: 250px;
background-color: #334155;
color: #fff;
text-align: center;
border-radius: 8px;
padding: 12px 24px;
position: fixed;
z-index: 2000;
left: 50%;
bottom: 30px;
transform: translateX(-50%);
font-weight: 600;
box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
}

#toast.show {
visibility: visible;
animation: fadein 0.5s, fadeout 0.5s 2.5s;
}

@keyframes fadein {
from {bottom: 0; opacity: 0;}
to {bottom: 30px; opacity: 1;}
}

@keyframes fadeout {
from {bottom: 30px; opacity: 1;}
to {bottom: 0; opacity: 0;}
}

@media (max-width: 768px) {
.header { flex-direction: column; text-align: center; gap: 20px; }
.button-group { justify-content: center; }
.ip-list-header { flex-direction: column; align-items: stretch; }
.ip-list-header h2 { text-align: center; }
.ip-item { flex-direction: column; gap: 10px; text-align: center; }
.ip-info { flex-direction: column; gap: 8px; }
}
</style>
</head>
<body>
<div class="container">
<div class="header">
<div class="header-content">
<h1>Cloudflare 优质 IP 库</h1>
<p>自动收集、测速、过滤，提供最优质的 Cloudflare 节点</p>
</div>
<div class="social-links">
<button class="theme-toggle" id="themeToggle" title="切换主题">
<svg width="20" height="20" viewBox="0 0 24 24">
<path id="themeToggleIcon" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
</svg>
</button>
<a href="https://youtube.com/@alienwaregf" target="_blank" class="social-link youtube" title="YouTube 频道">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
</svg>
</a>
<a href="https://github.com/alienwaregf" target="_blank" class="social-link github" title="GitHub">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
</svg>
</a>
<a href="https://t.me/alienwaregf" target="_blank" class="social-link telegram" title="Telegram 频道">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="M11.944 0C5.344 0 0 5.344 0 12c0 6.656 5.344 12 11.944 12 6.656 0 12-5.344 12-12 0-6.656-5.344-12-12-12zm5.892 8.468l-1.97 9.28c-.148.653-.536.812-1.084.504l-3.006-2.215-1.452 1.396c-.16.16-.295.295-.605.295l.216-3.06 5.572-5.035c.242-.214-.053-.332-.374-.118l-6.886 4.335-2.964-.926c-.644-.202-.657-.644.135-.953l11.572-4.46c.536-.196 1.006.128.832.962z"/>
</svg>
</a>
<button class="social-link" id="logoutBtn" title="退出登录" style="color: #ef4444;">
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
</svg>
</button>
</div>
</div>

<div class="card">
<h2>系统状态</h2>
<div class="stats">
<div class="stat">
<div class="stat-date">总计 IP 数量</div>
<div class="stat-value" id="totalIps">${data.count || 0}</div>
</div>
<div class="stat">
<div class="stat-date">过滤后优质 IP</div>
<div class="stat-value" style="color: #10b981;" id="fastIpsCount">${fastIPs.length}</div>
</div>
<div class="stat">
<div class="stat-date">最后更新时间</div>
<div style="font-weight: 600; margin-top: 8px;" id="lastUpdated">${formatDate(data.lastUpdated)}</div>
</div>
</div>

<div class="button-group">
<button class="button" id="updateBtn" onclick="triggerUpdate()">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
更新数据源
</button>
<button class="button button-warning" id="speedTestBtn" onclick="triggerSpeedTest()">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
触发自动测速
</button>
<button class="button button-secondary" onclick="openModal('sourceModal')">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
自定义数据源
</button>
<button class="button button-secondary" onclick="openModal('tokenModal')">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zM9 10V7a3 3 0 0 1 6 0v3H9z"/></svg>
Token 管理
</button>
<a href="/sub${tokenParam}" target="_blank" class="button button-sub">
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/></svg>
优选订阅接口
</a>
</div>
<div class="button-group" style="margin-bottom: 0;">
<div class="dropdown">
<button class="button button-secondary dropdown-btn">
📋 一键复制文本 ▾
</button>
<div class="dropdown-content">
<a onclick="copyTxt('/ip.txt')">普通端口 IP 纯文本</a>
<a onclick="copyTxt('/fast-ips.txt')">优质测速 IP 纯文本</a>
<a onclick="copyTxt('/cf-custom-port')">自定义端口格式</a>
<a onclick="copyTxt('/edgetunnel.txt')">EdgeTunnel 格式</a>
<a onclick="copyTxt('/cfnew.txt')">CFnew 专享格式</a>
</div>
</div>
<div class="dropdown">
<button class="button button-secondary dropdown-btn">
🔗 打开专属链接 ▾
</button>
<div class="dropdown-content">
<a href="/ip.txt" target="_blank">普通端口 IP 纯文本</a>
<a href="/fast-ips.txt" target="_blank">优质测速 IP 纯文本</a>
<a href="/cf-custom-port" target="_blank">自定义端口格式</a>
<a href="/edgetunnel.txt" target="_blank">EdgeTunnel 格式</a>
<a href="/cfnew.txt" target="_blank">CFnew 专享格式</a>
</div>
</div>
</div>
</div>

<div class="card">
<div class="ip-list-header">
<h2>优质 IP 列表 (${fastIPs.length})</h2>
<div style="font-size: 0.9rem; color: #64748b;">
展示延迟更低、速度更优的 Cloudflare 节点
</div>
</div>

<div class="ip-list" id="ipListContainer">
${fastIPs.map(item => `
<div class="ip-item">
<div class="ip-info">
<span class="ip-address">${item.ip}</span>
<span class="source-tag">${item.source || '未知'}</span>
${GEO_LOCATION_ENABLED ? `
<span class="ip-location loading-location" data-ip="${item.ip}">
查询中...
</span>
` : ''}
</div>
<span class="speed-result ${getSpeedClass(item.latency)}">${item.latency} ms</span>
</div>
`).join('')}
</div>
</div>

<div class="footer">
<p>Cloudflare Worker BestIP Collector © 2024-2025</p>
</div>
</div>

<div id="sourceModal" class="modal">
<div class="modal-content">
<button class="modal-close" onclick="closeModal('sourceModal')">×</button>
<h3 style="margin-bottom: 20px;">自定义数据源配置</h3>
<div class="form-group">
<label>数据源名称</label>
<input type="text" id="sourceNameInput" class="form-control" placeholder="例如: 华南优质IP">
</div>
<div class="form-group">
<label>数据源 URL (支持纯文本/带备注/换行等)</label>
<input type="text" id="sourceUrlInput" class="form-control" placeholder="https://example.com/ip.txt">
</div>
<button class="button button-success" style="width: 100%; margin-bottom: 20px;" onclick="addCustomSource()">添加并保存</button>
<h4 style="margin-bottom: 10px; border-top: 1px solid var(--card-border); padding-top: 15px;">已保存的自定义源</h4>
<div id="customSourcesList">
</div>
</div>
</div>

<div id="tokenModal" class="modal">
<div class="modal-content">
<button class="modal-close" onclick="closeModal('tokenModal')">×</button>
<h3 style="margin-bottom: 20px;">Token 安全防刷管理</h3>
<p style="font-size:12px; color:#64748b; margin-bottom:15px;">配置Token后，外部访问优选订阅接口（/sub）必须带上正确的 ?token= 才能正常拉取节点，有效防止刷量。</p>
<div class="form-group">
<label>访问 Token 密钥</label>
<input type="text" id="tokenValueInput" class="form-control" placeholder="留空则不开启 Token 校验">
</div>
<div class="form-group" id="expiresDaysGroup">
<label>到期有效时间 (天)</label>
<input type="number" id="tokenExpiresInput" class="form-control" value="30" min="1" max="365">
</div>
<div class="form-group" style="display:flex; align-items:center; gap:8px;">
<input type="checkbox" id="tokenNeverExpire" onchange="toggleExpiresInput(this.checked)">
<label for="tokenNeverExpire" style="margin-bottom:0; cursor:pointer;">永久有效</label>
</div>
<button class="button button-success" style="width: 100%; margin-bottom: 12px;" onclick="saveTokenConfig()">更新 Token 配置</button>
<button class="button button-warning" style="width: 100%;" onclick="deleteTokenConfig()">清除 Token 配置</button>
<div id="tokenStatusText" style="font-size:12px; color:#10b981; margin-top:12px; text-align:center; font-weight:600;"></div>
</div>
</div>

<div id="toast">提示信息</div>

<script>
// 主题控制
const body = document.body;
const themeToggleBtn = document.getElementById('themeToggle');
const themeToggleIcon = document.getElementById('themeToggleIcon');

// 页面加载时自动应用主题：优先本地缓存 -> 系统深色偏好
const savedTheme = localStorage.getItem('theme') || 'auto';
applyTheme(savedTheme);

function applyTheme(theme) {
if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
body.classList.add('dark-mode');
themeToggleIcon.setAttribute('d', 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-11.314l.707.707m11.314 11.314l.707.707M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z');
} else {
body.classList.remove('dark-mode');
themeToggleIcon.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
}
}

themeToggleBtn.addEventListener('click', () => {
if (body.classList.contains('dark-mode')) {
localStorage.setItem('theme', 'light');
applyTheme('light');
showToast('已切换至浅色模式');
} else {
localStorage.setItem('theme', 'dark');
applyTheme('dark');
showToast('已切换至深色模式');
}
});

// 批量地理位置异步查询逻辑
if (${GEO_LOCATION_ENABLED}) {
document.addEventListener('DOMContentLoaded', async () => {
const locElements = Array.from(document.querySelectorAll('.ip-location[data-ip]'));
const batchSize = ${GEO_BATCH_SIZE};

for (let i = 0; i < locElements.length; i += batchSize) {
const batch = locElements.slice(i, i + batchSize);
await Promise.all(batch.map(async (el) => {
const ip = el.getAttribute('data-ip');
try {
const res = await fetch('https://ipapi.co/' + ip + '/json/');
if(res.ok) {
const geo = await res.json();
if(geo && geo.country_code) {
const codePoints = geo.country_code.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
const flag = String.fromCodePoint(...codePoints);
const region = geo.city || geo.region || geo.country_name || '未知';
el.textContent = flag + ' ' + region;
} else { el.textContent = '🏳️ 外部节点'; }
} else { el.textContent = '🏳️ 外部节点'; }
} catch(e) { el.textContent = '❌ 查询失败'; }
el.classList.remove('loading-location');
}));
// 规避高并发IP地理位置API限流
await new Promise(r => setTimeout(r, 600));
}
});
}

// 退出登录
document.getElementById('logoutBtn').addEventListener('click', async () => {
if(confirm('确定要退出登录吗？')) {
const res = await fetch('/auth-logout');
if(res.ok) {
showToast('已安全退出');
setTimeout(() => location.reload(), 800);
}
}
});

function showToast(message) {
const toast = document.getElementById('toast');
toast.textContent = message;
toast.className = "show";
setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 300);
}

function openModal(id) {
document.getElementById(id).style.display = 'flex';
if(id === 'sourceModal') loadCustomSources();
if(id === 'tokenModal') loadTokenConfig();
}

function closeModal(id) {
document.getElementById(id).style.display = 'none';
}

async function triggerUpdate() {
const btn = document.getElementById('updateBtn');
btn.disabled = true;
btn.innerHTML = '正在拉取源...';
try {
const res = await fetch('/update', { method: 'POST' });
const d = await res.json();
if(d.success) {
showToast('数据源更新成功！请点击触发自动测速');
document.getElementById('totalIps').textContent = d.count;
document.getElementById('lastUpdated').textContent = '刚刚';
} else { showToast('失败: ' + d.error); }
} catch (e) { showToast('请求错误'); }
btn.disabled = false;
btn.innerHTML = '更新数据源';
}

async function triggerSpeedTest() {
const btn = document.getElementById('speedTestBtn');
btn.disabled = true;
btn.innerHTML = '正在自动测速中...';
try {
const res = await fetch('/speedtest');
const d = await res.json();
if(d.success) {
showToast('自动测速完成！优质节点已就绪');
setTimeout(() => location.reload(), 1000);
} else { showToast('失败: ' + d.error); }
} catch (e) { showToast('测速超时或错误，请刷新检查'); }
btn.disabled = false;
btn.innerHTML = '触发自动测速';
}

async function copyTxt(path) {
try {
const res = await fetch(path);
const text = await res.text();
navigator.clipboard.writeText(text);
showToast('已复制纯文本内容到剪贴板！');
} catch (e) { showToast('复制失败'); }
}

async function loadCustomSources() {
const list = document.getElementById('customSourcesList');
list.innerHTML = '加载中...';
try {
const res = await fetch('/get-custom-source');
const d = await res.json();
list.innerHTML = '';
if(!d.sources || d.sources.length === 0) {
list.innerHTML = '<div style="color:#64748b; font-size:12px; text-align:center;">暂无自定义数据源</div>';
return;
}
d.sources.forEach(s => {
const div = document.createElement('div');
div.className = 'source-item';
div.innerHTML = '<div class="source-name">' + s.name + '</div><div class="source-url">' + s.url + '</div><button class="btn-delete" onclick="deleteCustomSource(\'' + s.name + '\')">删除</button>';
list.appendChild(div);
});
} catch(e) { list.innerHTML = '加载失败'; }
}

async function addCustomSource() {
const name = document.getElementById('sourceNameInput').value.trim();
const url = document.getElementById('sourceUrlInput').value.trim();
if(!name || !url) { showToast('请填写完整名称和URL'); return; }
try {
const res = await fetch('/save-custom-source', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({name, url})
});
const d = await res.json();
if(d.success) {
showToast('添加成功');
document.getElementById('sourceNameInput').value = '';
document.getElementById('sourceUrlInput').value = '';
loadCustomSources();
} else { showToast('添加失败: ' + d.error); }
} catch(e) { showToast('网络错误'); }
}

async function deleteCustomSource(name) {
if(!confirm('确定要删除源 [' + name + '] 吗？')) return;
try {
const res = await fetch('/delete-custom-source', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({name})
});
const d = await res.json();
if(d.success) { showToast('已删除'); loadCustomSources(); }
} catch(e) { showToast('删除失败'); }
}

function toggleExpiresInput(neverExpire) {
document.getElementById('expiresDaysGroup').style.display = neverExpire ? 'none' : 'block';
}

async function loadTokenConfig() {
const statusText = document.getElementById('tokenStatusText');
statusText.textContent = '获取配置中...';
try {
const res = await fetch('/admin-token');
const d = await res.json();
if (d.tokenConfig && d.tokenConfig.token) {
document.getElementById('tokenValueInput').value = d.tokenConfig.token;
if (d.tokenConfig.neverExpire) {
document.getElementById('tokenNeverExpire').checked = true;
toggleExpiresInput(true);
statusText.textContent = '状态: 启用中 (永久有效)';
} else {
document.getElementById('tokenNeverExpire').checked = false;
toggleExpiresInput(false);
const daysLeft = Math.ceil((new Date(d.tokenConfig.expires) - Date.now()) / (1000 * 60 * 60 * 24));
statusText.textContent = '状态: 启用中 (约 ' + daysLeft + ' 天后过期)';
}
} else {
document.getElementById('tokenValueInput').value = '';
statusText.textContent = '状态: 未开启 Token 门禁';
}
} catch(e) { statusText.textContent = '获取状态失败'; }
}

async function saveTokenConfig() {
const token = document.getElementById('tokenValueInput').value.trim();
const expiresDays = parseInt(document.getElementById('tokenExpiresInput').value);
const neverExpire = document.getElementById('tokenNeverExpire').checked;
try {
const res = await fetch('/admin-token', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({ token, expiresDays, neverExpire })
});
const d = await res.json();
if(d.success) { showToast('Token 门禁配置已更新'); loadTokenConfig(); }
else { showToast('保存失败: ' + d.error); }
} catch(e) { showToast('网络错误'); }
}

async function deleteTokenConfig() {
if(!confirm('确定要清除 Token 门禁吗？清除后外部接口将不受保护。')) return;
try {
const res = await fetch('/admin-token', { method: 'DELETE' });
const d = await res.json();
if(d.success) { showToast('Token 已成功清除'); loadTokenConfig(); }
} catch(e) { showToast('操作失败'); }
}
</script>
</body>
</html>`;
return new Response(html, {
headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
}


// ========== 提供暗黑版授权页面 ==========
async function serveAuthPage(env) {
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>安全身份验证</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
background: #0f172a;
color: #cbd5e1;
height: 100vh;
display: flex;
justify-content: center;
align-items: center;
padding: 20px;
}
.auth-card {
background: #1e293b;
border: 1px solid #334155;
border-radius: 16px;
padding: 40px 30px;
width: 100%;
max-width: 400px;
box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3);
text-align: center;
}
.logo-container {
width: 64px;
height: 64px;
background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
border-radius: 16px;
display: flex;
justify-content: center;
align-items: center;
margin: 0 auto 24px;
box-shadow: 0 8px 16px rgba(59, 130, 246, 0.2);
}
h2 { font-size: 1.5rem; color: #fff; margin-bottom: 8px; font-weight: 600; }
p { color: #64748b; font-size: 0.95rem; margin-bottom: 24px; }
.form-group { margin-bottom: 20px; text-align: left; }
label { display: block; margin-bottom: 8px; font-size: 0.85rem; color: #94a3b8; font-weight: 600; letter-spacing: 0.05em; }
input {
width: 100%;
padding: 12px 16px;
background: #0f172a;
border: 1px solid #334155;
border-radius: 8px;
color: #fff;
font-size: 1rem;
transition: all 0.3s;
}
input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
button {
width: 100%;
padding: 12px;
background: #3b82f6;
border: none;
border-radius: 8px;
color: #fff;
font-size: 1rem;
font-weight: 600;
cursor: pointer;
transition: background 0.3s;
margin-top: 10px;
}
button:hover { background: #2563eb; }
#errMsg { color: #f87171; font-size: 0.85rem; margin-top: 12px; min-height: 20px; font-weight: 500; }
</style>
</head>
<body>
<div class="auth-card">
<div class="logo-container">
<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
</div>
<h2>管理密码验证</h2>
<p>此站点已受安全保护，请输入密码继续</p>
<div class="form-group">
<label for="password">PASSWORD</label>
<input type="password" id="password" placeholder="请输入绑定的环境变量密码" onkeydown="if(event.key==='Enter')login()">
</div>
<button onclick="login()">验证并登录</button>
<div id="errMsg"></div>
</div>
<script>
async function login() {
const pass = document.getElementById('password').value;
const err = document.getElementById('errMsg');
err.textContent = '';
if(!pass) { err.textContent = '密码不能为空'; return; }
try {
const res = await fetch('/auth-login', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ password: pass })
});
const data = await res.json();
if(data.success) { window.location.reload(); }
else { err.textContent = data.message || '密码不正确'; }
} catch(e) { err.textContent = '网络请求异常'; }
}
</script>
</body>
</html>`;
return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


// ========== 身份校验后端处理函数 ==========
async function handleLoginRequest(request, env, clientIP) {
try {
const { password } = await request.json();
if (!password || password !== env.password) {
return new Response(JSON.stringify({ success: false, message: '密码验证失败' }), { status: 401 });
}
const token = btoa(env.password + '_auth_session');
return new Response(JSON.stringify({ success: true }), {
headers: {
'Content-Type': 'application/json',
'Set-Cookie': `cf_ip_auth=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax; Secure`
}
});
} catch (e) {
return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
}
}

async function verifyAuthCookie(cookieStr, expectedPassword) {
if (!expectedPassword) return false;
const cookies = cookieStr.split(';').reduce((acc, c) => {
const [k, v] = c.trim().split('=');
if (k) acc[k] = v;
return acc;
}, {});
const expectedToken = btoa(expectedPassword + '_auth_session');
return cookies['cf_ip_auth'] === expectedToken;
}


// ========== 后端底层通用逻辑 ==========
async function handleUpdate(env) {
const { uniqueIPs, results } = await updateAllIPs(env);
await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
ips: uniqueIPs,
lastUpdated: new Date().toISOString(),
count: uniqueIPs.length,
sources: results
}));
return jsonResponse({ success: true, count: uniqueIPs.length });
}

async function handleGetIPs(env) {
const data = await getStoredIPs(env);
return new Response(data.ips.join('\n'), {
headers: { 'Content-Type': 'text/plain; charset=utf-8' }
});
}

async function handleRawIPs(env) {
const data = await getStoredIPs(env);
return jsonResponse(data);
}

async function handleGetFastIPs(env) {
const data = await getStoredSpeedIPs(env);
return jsonResponse(data.fastIPs || []);
}

async function handleGetFastIPsText(env) {
const data = await getStoredSpeedIPs(env);
const text = (data.fastIPs || []).map(item => item.ip).join('\n');
return new Response(text, {
headers: { 'Content-Type': 'text/plain; charset=utf-8' }
});
}

// 新增逻辑：EdgeTunnel 专属纯 IP 节点格式支持
async function handleGetEdgeTunnelIPs(request, env) {
const data = await getStoredSpeedIPs(env);
const remark = env.SUB_REMARK || 'CF-Worker';
const url = new URL(request.url);
const port = url.searchParams.get('port') || '443';
const text = (data.fastIPs || []).map(item => `${item.ip}:${port}#${getNodeRemark(item, remark)}`).join(',');
return new Response(text, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Access-Control-Allow-Origin': '*'
}
});
}

// 新增逻辑：CFNew 专属纯格式，带有引用 URL 的一键复制
async function handleGetCFNewIPs(request, env) {
const data = await getStoredSpeedIPs(env);
const url = new URL(request.url);
const currentDomain = url.hostname;
const port = url.searchParams.get('port') || '443';

let text = '';
(data.fastIPs || []).forEach(item => {
text += `${item.ip}:${port}\n`;
});

text += `\n// 如需引用此自动更新接口，请复制下方 URL：\n// https://${currentDomain}/cfnew.txt\n`;

return new Response(text, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Access-Control-Allow-Origin': '*'
}
});
}

// 新增逻辑：自定义端口版格式
async function handleGetCFCustomPort(request, env) {
const data = await getStoredSpeedIPs(env);
const url = new URL(request.url);
const port = url.searchParams.get('port') || '443';
const text = (data.fastIPs || []).map(item => `${item.ip}#${item.ip}:${port}`).join('\n');
return new Response(text, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Access-Control-Allow-Origin': '*'
}
});
}

// --- 新增逻辑：自定义来源管理后端 ---
async function handleSaveCustomSource(request, env) {
try {
const { name, url } = await request.json();
if(!name || !url) return jsonResponse({ error: '参数不完整' }, 400);

let current = await env.IP_STORAGE.get('custom_sources', 'json') || [];
current = current.filter(s => s.name !== name); // 避免重复名
current.push({ name: name.trim(), url: url.trim() });

await env.IP_STORAGE.put('custom_sources', JSON.stringify(current));
return jsonResponse({ success: true });
} catch(e) {
return jsonResponse({ error: e.message }, 500);
}
}

async function handleGetCustomSource(env) {
const sources = await env.IP_STORAGE.get('custom_sources', 'json') || [];
return jsonResponse({ sources });
}

async function handleDeleteCustomSource(request, env) {
try {
const { name } = await request.json();
let current = await env.IP_STORAGE.get('custom_sources', 'json') || [];
current = current.filter(s => s.name !== name);
await env.IP_STORAGE.put('custom_sources', JSON.stringify(current));
return jsonResponse({ success: true });
} catch(e) {
return jsonResponse({ error: e.message }, 500);
}
}

// --- 新增逻辑：Token管理后端接口 ---
async function handleAdminToken(request, env) {
if (request.method === 'GET') {
const config = await getTokenConfig(env);
return jsonResponse({ tokenConfig: config });
} else if (request.method === 'POST') {
try {
const { token, expiresDays, neverExpire } = await request.json();
if (!token) return jsonResponse({ error: 'Token不能为空' }, 400);

let expiresDate;
if (neverExpire) {
expiresDate = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();
} else {
if (!expiresDays) return jsonResponse({ error: '过期时间不能为空' }, 400);
if (expiresDays < 1 || expiresDays > 365) return jsonResponse({ error: '过期时间必须在1-365天之间' }, 400);
expiresDate = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
}

const tokenConfig = {
token: token.trim(),
expires: expiresDate,
createdAt: new Date().toISOString(),
lastUsed: null,
neverExpire: neverExpire || false
};

await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));
return jsonResponse({ success: true, tokenConfig, message: 'Token更新成功' });
} catch (error) {
return jsonResponse({ error: error.message }, 500);
}
} else if (request.method === 'DELETE') {
try {
await env.IP_STORAGE.delete('token_config');
return jsonResponse({ success: true, message: 'Token配置已成功清除' });
} catch (error) {
return jsonResponse({ error: error.message }, 500);
}
}
}

async function handleSpeedTest(request, env) {
const data = await getStoredIPs(env);
if (!data.ips || data.ips.length === 0) {
return jsonResponse({ error: 'No IPs found. Please update sources first.' }, 400);
}
const ipsToTest = data.ips.slice(0, AUTO_TEST_MAX_IPS);
ctx.waitUntil(autoSpeedTestAndStore(env, ipsToTest));
return jsonResponse({ success: true, message: `Speed test scheduled for ${ipsToTest.length} IPs.` });
}

async function handleItdogData(env) {
const data = await getStoredSpeedIPs(env);
return jsonResponse(data);
}

// ========== 测速与数据存储辅助函数 ==========
async function autoSpeedTestAndStore(env, ips) {
console.log(`Starting speed test for ${ips.length} IPs...`);
const testResults = [];
const batchSize = 15;

for (let i = 0; i < ips.length; i += batchSize) {
const batch = ips.slice(i, i + batchSize);
await Promise.all(batch.map(async (ipData) => {
let ip = typeof ipData === 'string' ? ipData : ipData.ip;
let source = typeof ipData === 'string' ? '未知' : (ipData.source || '未知');
const latency = await testIpLatency(ip);
if (latency !== null) {
testResults.push({ ip, latency, source });
}
}));
}

testResults.sort((a, b) => a.latency - b.latency);
const fastIPs = testResults.slice(0, FAST_IP_COUNT);

await env.IP_STORAGE.put('cloudflare_speed_ips', JSON.stringify({
fastIPs,
lastTested: new Date().toISOString(),
count: fastIPs.length
}));
console.log(`Speed test done. Found ${fastIPs.length} premium IPs.`);
}

async function testIpLatency(ip) {
const url = `https://${ip}/__cf_performance_test`;
const timeout = 1200;
const startTime = Date.now();

try {
const controller = new AbortController();
const id = setTimeout(() => controller.abort(), timeout);
const response = await fetch(url, {
method: 'GET',
signal: controller.signal,
headers: { 'User-Agent': 'Mozilla/5.0' }
});
clearTimeout(id);
return Date.now() - startTime;
} catch (e) {
return null;
}
}

async function updateAllIPs(env) {
const defaultSources = [
{ name: '官方IPv4', url: 'https://www.cloudflare.com/ips-v4' },
{ name: 'Miku库', url: 'https://raw.githubusercontent.com/MikuNuco/Cloudflare-IP/main/Proxy-IP.txt' }
];
const customSources = await env.IP_STORAGE.get('custom_sources', 'json') || [];
const allSources = [...defaultSources, ...customSources];
const uniqueIPs = [];
const results = [];

for (const src of allSources) {
try {
const res = await fetch(src.url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const text = await res.text();
const found = extractIPs(text);
let addedCount = 0;
found.forEach(ip => {
if (!uniqueIPs.some(item => item.ip === ip)) {
uniqueIPs.push({ ip, source: src.name });
addedCount++;
}
});
results.push({ name: src.name, status: 'success', count: found.length, added: addedCount });
} catch (e) {
results.push({ name: src.name, status: 'failed', error: e.message });
}
}
return { uniqueIPs, results };
}

function extractIPs(text) {
const ipRegex = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g;
const matches = text.match(ipRegex) || [];
return [...new Set(matches)];
}

async function getStoredIPs(env) {
const raw = await env.IP_STORAGE.get('cloudflare_ips');
if (!raw) return { ips: [], lastUpdated: null, count: 0 };
try {
const data = JSON.parse(raw);
if (data.ips && data.ips.length > 0 && typeof data.ips[0] === 'object') {
data.ips = data.ips.map(item => item.ip);
}
return data;
} catch(e) {
return { ips: [], lastUpdated: null, count: 0 };
}
}

async function getStoredSpeedIPs(env) {
const raw = await env.IP_STORAGE.get('cloudflare_speed_ips');
return raw ? JSON.parse(raw) : { fastIPs: [], lastTested: null };
}

async function getTokenConfig(env) {
const raw = await env.IP_STORAGE.get('token_config');
if (!raw) return null;
try {
const config = JSON.parse(raw);
if (!config.neverExpire && new Date(config.expires) < new Date()) {
await env.IP_STORAGE.delete('token_config');
return null;
}
return config;
} catch(e) {
return null;
}
}

function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data), {
status,
headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
});
}

function handleCORS() {
return new Response(null, {
headers: {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}
});
}

function formatDate(isoString) {
if (!isoString) return '从未';
const date = new Date(isoString);
const y = date.getFullYear();
const m = String(date.getMonth() + 1).padStart(2, '0');
const d = String(date.getDate()).padStart(2, '0');
const h = String(date.getHours()).padStart(2, '0');
const min = String(date.getMinutes()).padStart(2, '0');
const s = String(date.getSeconds()).padStart(2, '0');
return `${y}年${m}月${d}日 ${h}:${min}:${s}`;
}

function getSpeedClass(ms) {
if (ms < 150) return 'speed-fast';
if (ms < 300) return 'speed-medium';
return 'speed-slow';
}
