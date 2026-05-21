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

// Joey/EdgeTunnel 格式: IP:端口#备注, 逗号分隔
async function generateJoeySubscription(fastIPs, port, remark) {
    const nodeList = fastIPs.map(item => `${item.ip}:${port}#${remark}·${item.ip}`).join(',');
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
    const nodeList = fastIPs.map(item => `${item.ip}:${port}#${remark}·${item.ip}`).join('\n');
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
    const nodeList = fastIPs.map(item => `${item.ip}:${port}@${sni}#${remark}·${item.ip}`).join('\n');
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
            encodeURIComponent(remark + '\u00b7' + item.ip);
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
        nodeLinks.push(`vless://${uuid}@${item.ip}:${port}?encryption=none&security=tls&sni=${sni}&fp=chrome&type=tcp${proxyIP ? '&proxyIP=' + proxyIP : ''}#${remark}·VLESS·${item.ip}`);
    });
    fastIPs.forEach(item => {
        nodeLinks.push(`trojan://${uuid}@${item.ip}:${port}?security=tls&sni=${sni}&fp=chrome&type=tcp#${remark}·Trojan·${item.ip}`);
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
        `vless://${uuid}@${item.ip}:${port}?encryption=none&security=tls&sni=${sni}&fp=chrome&type=tcp${proxyIP ? '&proxyIP=' + proxyIP : ''}#${remark}·${item.ip}`
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
        `trojan://${uuid}@${item.ip}:${port}?security=tls&sni=${sni}&fp=chrome&type=tcp#${remark}·${item.ip}`
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
        const vlessName = `${remark}·VL·${shortIp}`;
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
        const trojanName = `${remark}·TR·${shortIp}`;
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
<h1>\u{1F338} 优选订阅接口</h1>
<div class="subtitle"><span class="dot"></span> 系统运行中 \u00b7 ${fastIPs.length} 个优质IP可用</div>

<div class="stats">
<div class="stat-item"><div class="stat-value">${fastIPs.length}</div><div class="stat-label">优质IP数量</div></div>
<div class="stat-item"><div class="stat-value">8</div><div class="stat-label">接口类型</div></div>
<div class="stat-item"><div class="stat-value">24h</div><div class="stat-label">自动更新</div></div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-blue">EdgeTunnel / Joey 专用</span></div>
<div class="desc">进入 <strong>Joey项目后台</strong> \u2192 延迟测试 \u2192 URL获取 \u2192 粘贴接口URL</div>
<div class="url-box">${workerUrl}/sub?joey${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-blue" onclick="copy('${workerUrl}/sub?joey${tokenAnd}')">\u{1F4CB} 复制 Joey 接口</button>
<a href="/sub?joey${tokenAnd}" target="_blank" class="btn btn-blue" style="text-decoration:none">\u{1F517} 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-purple">CMLIU 订阅接口</span></div>
<div class="desc">进入 <strong>cmliu项目后台</strong> \u2192 优选订阅生成 \u2192 粘贴接口URL</div>
<div class="url-box">${workerUrl}/sub?cml${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-purple" onclick="copy('${workerUrl}/sub?cml${tokenAnd}')">\u{1F4CB} 复制 CMLIU 接口</button>
<a href="/sub?cml${tokenAnd}" target="_blank" class="btn btn-purple" style="text-decoration:none">\u{1F517} 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-pink">SNI 接口</span></div>
<div class="desc">改写代码时替换 <strong>上游订阅器位置</strong>，格式: IP:端口@SNI#备注</div>
<div class="url-box">${workerUrl}/sub?sni${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-pink" onclick="copy('${workerUrl}/sub?sni${tokenAnd}')">\u{1F4CB} 复制 SNI 接口</button>
<a href="/sub?sni${tokenAnd}" target="_blank" class="btn btn-pink" style="text-decoration:none">\u{1F517} 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-green">Base64 通用订阅</span></div>
<div class="desc">适用于 <strong>V2Ray / Shadowrocket / Quantumult X</strong> 等客户端，包含VLESS+Trojan节点</div>
<div class="url-box">${workerUrl}/sub?base64${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-green" onclick="copy('${workerUrl}/sub?base64${tokenAnd}')">\u{1F4CB} 复制订阅链接</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-orange">VLESS 订阅</span></div>
<div class="desc">纯 <strong>VLESS</strong> 节点 Base64 订阅，适配 EdgeTunnel/Sub Store</div>
<div class="url-box">${workerUrl}/sub?vless${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-orange" onclick="copy('${workerUrl}/sub?vless${tokenAnd}')">\u{1F4CB} 复制 VLESS 订阅</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-cyan">Trojan 订阅</span></div>
<div class="desc">纯 <strong>Trojan</strong> 节点 Base64 订阅</div>
<div class="url-box">${workerUrl}/sub?trojan${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-cyan" onclick="copy('${workerUrl}/sub?trojan${tokenAnd}')">\u{1F4CB} 复制 Trojan 订阅</button>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-blue">Clash 订阅</span></div>
<div class="desc">适用于 <strong>Clash / ClashX / Clash for Windows</strong>，包含自动选择/故障转移/负载均衡策略组</div>
<div class="url-box">${workerUrl}/sub?clash${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-blue" onclick="copy('${workerUrl}/sub?clash${tokenAnd}')">\u{1F4CB} 复制 Clash 订阅</button>
<a href="/sub?clash${tokenAnd}" target="_blank" class="btn btn-blue" style="text-decoration:none">\u{1F517} 在线预览</a>
</div>
</div>

<div class="card">
<div class="card-header"><span class="badge badge-red">EdgeTunnel 优选订阅生成器</span></div>
<div class="desc">适配 <strong>CMLIU EdgeTunnel</strong> 的优选订阅生成器接口，在 EdgeTunnel 中设置 BEST_SUB 环境变量为此URL</div>
<div class="url-box">${workerUrl}/sub?host=WORKER域名&uuid=你的UUID${tokenAnd}</div>
<div class="btn-row">
<button class="btn btn-red" onclick="copy('${workerUrl}/sub?host=WORKER域名&uuid=你的UUID${tokenAnd}')">\u{1F4CB} 复制 EdgeTunnel 接口</button>
</div>
</div>

<div class="footer"><p>Cloudflare Worker BestIP Collector \u00b7 优选订阅服务</p></div>
</div>
<script>
function copy(text){navigator.clipboard.writeText(text).then(()=>{const t=document.createElement('div');t.textContent='\u2705 已复制';t.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(59,130,246,.9);color:#fff;padding:10px 24px;border-radius:30px;font-size:13px;font-weight:700;z-index:9999;box-shadow:0 5px 15px rgba(0,0,0,.3)';document.body.appendChild(t);setTimeout(()=>t.remove(),1500)});}
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

.action-buttons {
display: flex;
gap: 8px;
}

.small-btn {
padding: 6px 12px;
border-radius: 8px;
font-size: 0.8rem;
border: 1px solid var(--card-border);
background: var(--card-bg);
color: var(--text-color);
cursor: pointer;
transition: all 0.3s ease;
}

.small-btn:hover {
background: var(--hover-bg);
border-color: #94a3b8;
}

.small-btn:disabled {
opacity: 0.5;
cursor: not-allowed;
}

.loading {
display: none;
text-align: center;
padding: 30px;
}

.spinner {
border: 3px solid var(--card-border);
border-top: 3px solid #3b82f6;
border-radius: 50%;
width: 40px;
height: 40px;
animation: spin 1s linear infinite;
margin: 0 auto 16px;
}

@keyframes spin {
0% { transform: rotate(0deg); }
100% { transform: rotate(360deg); }
}

.result {
margin: 20px 0;
padding: 16px 20px;
border-radius: 12px;
display: none;
border-left: 4px solid;
}

.success {
background: #d1fae5;
color: #065f46;
border-left-color: #10b981;
}

.error {
background: #fee2e2;
color: #991b1b;
border-left-color: #ef4444;
}

.speed-test-progress {
margin: 16px 0;
background: var(--card-border);
border-radius: 8px;
height: 8px;
overflow: hidden;
display: none;
}

.speed-test-progress-bar {
background: linear-gradient(90deg, #3b82f6, #06b6d4);
height: 100%;
width: 0%;
transition: width 0.3s ease;
}

.sources {
display: grid;
gap: 12px;
}

.source {
padding: 12px 16px;
background: var(--stat-bg);
border-radius: 8px;
border-left: 4px solid #10b981;
}

.source.error {
border-left-color: #ef4444;
}

.custom-sources-list {
margin-top: 20px;
display: grid;
gap: 12px;
max-height: 380px;
overflow-y: auto;
padding-right: 5px;
}

.custom-source-item {
display: flex;
justify-content: space-between;
align-items: center;
background: var(--stat-bg);
padding: 10px 15px;
border-radius: 8px;
border: 1px solid var(--card-border);
font-size: 0.9rem;
}

.delete-btn {
background: #fee2e2;
color: #dc2626;
border: 1px solid #fecaca;
padding: 4px 10px;
border-radius: 6px;
cursor: pointer;
font-size: 0.8rem;
transition: all 0.2s;
}

.delete-btn:hover {
background: #fecaca;
border-color: #dc2626;
}

.footer {
text-align: center;
margin-top: 40px;
padding-top: 30px;
border-top: 1px solid var(--card-border);
color: #64748b;
}

.modal {
display: none;
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100%;
background: rgba(0, 0, 0, 0.5);
backdrop-filter: blur(5px);
z-index: 1000;
justify-content: center;
align-items: center;
}

.modal-content {
background: var(--modal-bg);
padding: 30px;
border-radius: 16px;
max-width: 500px;
width: 90%;
border: 1px solid var(--card-border);
box-shadow: 0 20px 25px rgba(0, 0, 0, 0.1);
color: var(--text-color);
}

.modal h3 {
margin-bottom: 16px;
color: #3b82f6;
}

.modal-buttons {
display: flex;
gap: 12px;
justify-content: flex-end;
margin-top: 20px;
}

@media (max-width: 768px) {
.header {
flex-direction: column;
gap: 20px;
text-align: center;
}
.header-content h1 {
font-size: 2rem;
}
.social-links {
justify-content: center;
width: 100%;
flex-wrap: nowrap;
}
.social-links .dropdown {
width: auto;
}
.button-group {
flex-direction: column;
}
.button {
width: 100%;
justify-content: center;
}
.dropdown {
width: 100%;
}
.ip-list-header {
flex-direction: column;
align-items: flex-start;
}
.ip-item {
flex-direction: column;
align-items: flex-start;
gap: 12px;
}
.ip-info {
width: 100%;
justify-content: space-between;
}
.action-buttons {
width: 100%;
justify-content: flex-end;
}
.modal-buttons {
flex-direction: column;
}
}

.token-section { background: var(--stat-bg); border-radius: 12px; padding: 20px; margin-top: 20px; border: 1px solid var(--card-border); }
.token-info { background: var(--card-bg); padding: 16px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--card-border); }
.token-display { font-family: 'SF Mono', 'Courier New', monospace; background: #1e293b; color: #f1f5f9; padding: 12px; border-radius: 6px; margin: 8px 0; word-break: break-all; }
.form-group { margin-bottom: 16px; text-align: left; }
.form-label { display: block; margin-bottom: 8px; font-weight: 600; color: var(--text-color); }
.form-input { width: 100%; padding: 10px 12px; border: 2px solid var(--card-border); border-radius: 8px; font-size: 0.95rem; background: var(--bg-color); color: var(--text-color); transition: border-color 0.3s ease; }
.form-input:focus { outline: none; border-color: #3b82f6; }
.form-input:disabled { background-color: var(--stat-bg); color: #64748b; }
.form-help { font-size: 0.85rem; color: #64748b; margin-top: 4px; }
.checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.checkbox-label { font-weight: 600; color: var(--text-color); cursor: pointer; }

</style>
</head>
<body>
<div class="container">
<div class="header">
<div class="header-content">
<h1>Cloudflare 优选IP 收集器 UI+</h1>
<p> 自动定时拉取IP并测速</p>
</div>
<div class="social-links">
<div class="dropdown">
<button class="theme-toggle" title="切换深浅色模式">
<svg class="sun-icon" width="20" height="20" viewBox="0 0 24 24" style="display:none">
<circle cx="12" cy="12" r="5"></circle>
<line x1="12" y1="1" x2="12" y2="3"></line>
<line x1="12" y1="21" x2="12" y2="23"></line>
<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
<line x1="1" y1="12" x2="3" y2="12"></line>
<line x1="21" y1="12" x2="23" y2="12"></line>
<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
</svg>
<svg class="moon-icon" width="20" height="20" viewBox="0 0 24 24">
<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
</svg>
</button>
<div class="dropdown-content" style="min-width: 100px;">
<a onclick="setTheme('system')">🖥️ 系统</a>
<a onclick="setTheme('light')">🌞 浅色</a>
<a onclick="setTheme('dark')">🌙 深色</a>
</div>
</div>

<a href="https://youtu.be/rZl2jz--Oes" target="_blank" title="好软推荐" class="social-link youtube">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.546 12 3.546 12 3.546s-7.505 0-9.377.504A3.016 3.016 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.504 9.376.504 9.376.504s7.505 0 9.377-.504a3.016 3.016 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12 9.545 15.568z"/>
</svg>
</a>
<a href="https://github.com/ethgan/CF-Worker-BestIP-collector" target="_blank" title="GitHub" class="social-link github">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.085 8.199-11.386 0-6.627-5.373-12-12-12z"/>
</svg>
</a>
<a href="https://github.com/alienwaregf/CF-Worker-BestIP-collector-UI" target="_blank" title="感谢好软推荐" class="social-link">
<img src="https://raw.githubusercontent.com/alienwaregf/personal-use/refs/heads/main/image/Favicon/github.svg" width="20" height="20" style="display: block;">
</a>
<a href="https://t.me/yt_hytj" target="_blank" title="Telegram" class="social-link telegram">
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
<path d="m20.665 3.717-17.73 6.837c-1.21.486-1.203 1.161-.222 1.462l4.552 1.42 10.532-6.645c.498-.303.953-.14.579.192l-8.533 7.701h-.002l.002.001-.314 4.692c.46 0 .663-.211.921-.46l2.211-2.15 4.599 3.397c.848.467 1.457.227 1.668-.785l3.019-14.228c.309-1.239-.473-1.8-1.282-1.434z"/>
</svg>
</a>
</div>
</div>

<div class="card">
<h2>📊 系统状态</h2>
<div class="stats">
<div class="stat">
<div class="stat-value" id="ip-count">${data.count || 0}</div>
<div>IP 地址数量</div>
</div>
<div class="stat">
<div class="stat-value" id="last-updated">${data.lastUpdated ? '已更新' : '未更新'}</div>
<div>最后更新</div>
</div>
<div class="stat">
<div class="stat-date" id="last-date">----/--/--</div>
<div class="stat-value" id="last-time">--:--:--</div>
<div>更新时间</div>
</div>
<div class="stat">
<div class="stat-value" id="fast-ip-count">${fastIPs.length}</div>
<div>优质 IP 数量</div>
</div>
</div>

<div class="button-group">
<button class="button" onclick="updateIPs()" id="update-btn">
🔄 立即更新
</button>

<div class="dropdown">
<a href="javascript:void(0)" class="button button-edgetunnel dropdown-btn">
edgetunnel版
<span style="font-size: 0.8rem;">▼</span>
</a>
<div class="dropdown-content">
<a href="/edgetunnel.txt${tokenParam}" target="_blank">🔗 在线查看</a>
<a href="/edgetunnel.txt${tokenParam}" download="edgetunnel_ips.txt">📥 下载文件</a>
</div>
</div>

<div class="dropdown">
<a href="javascript:void(0)" class="button button-cfnew dropdown-btn">
CFnew版
<span style="font-size: 0.8rem;">▼</span>
</a>
<div class="dropdown-content">
<a href="/cfnew.txt${tokenParam}" target="_blank">🔗 在线查看</a>
<a href="/cfnew.txt${tokenParam}" download="cfnew_ips.txt">📥 下载文件</a>
<a href="javascript:void(0)" onclick="openCustomPortLink()">♻️ 自动更新</a>
</div>
</div>

<div class="dropdown">
<a href="javascript:void(0)" class="button button-sub dropdown-btn">
🌸 订阅接口
<span style="font-size: 0.8rem;">▼</span>
</a>
<div class="dropdown-content">
<a href="/sub${tokenParam.replace('?','?')}" target="_blank">📋 订阅控制台</a>
<a href="/sub?joey${tokenParam.replace('?','&')}" target="_blank">🔵 Joey接口</a>
<a href="/sub?clash${tokenParam.replace('?','&')}" target="_blank">💎 Clash订阅</a>
<a href="/sub?base64${tokenParam.replace('?','&')}" target="_blank">🟢 Base64订阅</a>
<a href="/sub?vless${tokenParam.replace('?','&')}" target="_blank">🟠 VLESS订阅</a>
<a href="/sub?trojan${tokenParam.replace('?','&')}" target="_blank">🔵 Trojan订阅</a>
<a href="/sub?cml${tokenParam.replace('?','&')}" target="_blank">🟣 CMLIU接口</a>
<a href="/sub?sni${tokenParam.replace('?','&')}" target="_blank">🩷 SNI接口</a>
<a href="/sub?edgetunnel" target="_blank">🔴 EdgeTunnel优选</a>
</div>
</div>

<button class="button button-warning" onclick="startSpeedTest()" id="speedtest-btn">
⚡ 开始测速
</button>
<button class="button" onclick="openItdogModal()">
🌐 ITDog 测速
</button>
<button class="button button-secondary" onclick="refreshData()">
🔄 刷新状态
</button>
<button class="button button-secondary" onclick="logout()">⏏️ 退出登陆</button>
</div>

<div class="loading" id="loading">
<div class="spinner"></div>
<p>正在从多个来源收集 IP 地址，请稍候...</p>
</div>

<div class="result" id="result"></div>

<div class="token-section">
<h3>🔑 API Token 状态</h3>
${tokenConfig ? `
<div class="token-info">
<p><strong>当前 Token:</strong></p>
<div class="token-display">${tokenConfig.token}</div>
<p><strong>过期时间:</strong> ${tokenConfig.neverExpire ? '永不过期' : new Date(tokenConfig.expires).toLocaleString()}</p>
${tokenConfig.lastUsed ? `<p><strong>最后使用:</strong> ${new Date(tokenConfig.lastUsed).toLocaleString()}</p>` : ''}
</div>
` : '<p style="margin-bottom: 15px; color: #64748b;">暂无Token配置，请点击下方按钮进行配置。</p>'}

<div style="display: flex; gap: 10px; flex-wrap: wrap;">
<button class="button button-warning" onclick="openTokenModal()">⚙️ 配置 Token</button>
</div>
</div>

</div>

<div class="card">
<div class="ip-list-header">
<h2>⚡ 优质 IP 列表</h2>
<div>
<button class="small-btn" onclick="copyAllFastIPs()">
📋 复制优质IP
</button>
</div>
</div>

<div class="speed-test-progress" id="speed-test-progress">
<div class="speed-test-progress-bar" id="speed-test-progress-bar"></div>
</div>
<div style="text-align: center; margin: 8px 0; font-size: 0.9rem; color: #64748b;" id="speed-test-status">准备测速...</div>

<div class="ip-list" id="ip-list">
${fastIPs.length > 0 ?
fastIPs.map(item => {
const ip = item.ip;
const latency = item.latency;
const location = item.location || {};
const speedClass = latency < 200 ? 'speed-fast' : latency < 500 ? 'speed-medium' : 'speed-slow';
const locationText = location.country ?
`${location.city || location.country}${location.org ? ' · ' + location.org : ''}` :
'📍 查询中...';
const locationClass = location.country ? '' : ' loading-location';
const countryCode = location.countryCode || '';
return `
<div class="ip-item" data-ip="${ip}">
<div class="ip-info">
<span class="ip-address">${ip}</span>
<span class="speed-result ${speedClass}" id="speed-${ip.replace(/\./g, '-')}">${latency}ms</span>
<span class="ip-location${locationClass}" id="loc-${ip.replace(/\./g, '-')}" data-cc="${countryCode}" title="${location.country ? location.country + ' ' + (location.city || '') + ' | ' + (location.org || '') : '正在查询地理位置...'}">${locationText}</span>
</div>
<div class="action-buttons">
<button class="small-btn" onclick="copyIP('${ip}')">复制</button>
</div>
</div>
`}).join('') :
'<p style="text-align: center; color: #64748b; padding: 40px;">暂无优质 IP 地址数据，请点击更新按钮获取</p>'
}
</div>
</div>

<div class="card">
<h2>🔗 自定义数据源</h2>
<div style="display: flex; gap: 10px; flex-wrap: wrap;">
<input type="text" id="custom-source-input" placeholder="添加新的 IP 列表 URL (例如: https://example.com/ips.txt)" style="flex: 1; padding: 12px; border: 1px solid var(--card-border); border-radius: 10px; background: var(--bg-color); color: var(--text-color); min-width: 200px;">
<button class="button" onclick="saveCustomSource()">添加源</button>
</div>
<p style="margin-top: 10px; color: #64748b; font-size: 0.9rem;">提示：输入一个返回纯文本IP列表的URL，点击添加后，该来源将加入到下方的来源状态列表中（下次更新生效）。</p>

<h3 style="margin-top: 20px; font-size: 1.1rem; color: #3b82f6;">已保存的自定义源</h3>
<div class="custom-sources-list" id="saved-custom-sources">
<p style="color: #64748b; font-size: 0.9rem;">暂无自定义源</p>
</div>
</div>

<div class="card">
<h2>🌍 数据来源状态</h2>
<div class="sources" id="sources">
${data.sources ? data.sources.map(source => `
<div class="source ${source.status === 'success' ? '' : 'error'}">
<strong>${source.name}</strong>:
${source.status === 'success' ?
`成功获取 ${source.count} 个IP` :
`失败: ${source.error}`
}
</div>
`).join('') : '<p style="color: #64748b;">暂无数据来源信息</p>'}
</div>
</div>

<div class="footer">
<p>Cloudflare IP Collector &copy; ${new Date().getFullYear()} | 好软推荐</p>
</div>
</div>

<div class="modal" id="itdog-modal">
<div class="modal-content">
<h3>🌐 ITDog 批量 TCPing 测速</h3>
<p>ITDog.cn 提供了从多个国内监测点进行 TCPing 测速的功能，可以更准确地测试 IP 在国内的连通性。</p>
<p><strong>使用方法：</strong></p>
<ol style="margin-left: 20px; margin-bottom: 16px;">
<li>点击下方按钮复制所有 IP 地址</li>
<li>打开 ITDog 批量 TCPing 页面</li>
<li>将复制的 IP 粘贴到输入框中</li>
<li>点击开始测试按钮</li>
</ol>
<p><strong>注意：</strong> ITDog 免费版可能有 IP 数量限制，如果 IP 过多请分批测试。</p>
<div class="modal-buttons">
<button class="button button-secondary" onclick="closeItdogModal()">取消</button>
<button class="button" onclick="copyIPsForItdog()">复制 IP 列表</button>
<a href="https://www.itdog.cn/batch_tcping/" class="button button-success" target="_blank">打开 ITDog</a>
</div>
</div>
</div>

<div class="modal" id="token-modal">
<div class="modal-content">
<h3>⚙️ Token 配置</h3>
<div class="form-group">
<label class="form-label">Token 字符串</label>
<input type="text" class="form-input" id="token-input" placeholder="输入自定义Token或留空自动生成">
<div class="form-help">建议使用复杂的随机字符串，长度至少16位</div>
</div>
<div class="checkbox-group">
<input type="checkbox" id="never-expire-checkbox" onchange="toggleExpireInput()">
<label class="checkbox-label" for="never-expire-checkbox">永不过期</label>
</div>
<div class="form-group" id="expires-group">
<label class="form-label">过期天数</label>
<input type="number" class="form-input" id="expires-days" value="30" min="1" max="365">
<div class="form-help">设置Token的有效期（1-365天）</div>
</div>
<div class="modal-buttons">
<button class="button" onclick="clearTokenConfig()" style="margin-right: auto; background-color: #ef4444; border-color: #ef4444; color: white;">🗑️ 清除配置</button>
<button class="button button-secondary" onclick="closeTokenModal()">取消</button>
<button class="button" onclick="generateRandomToken()">🎲 随机生成</button>
<button class="button button-success" onclick="saveTokenConfig()">保存</button>
</div>
</div>
</div>

<div class="modal" id="port-modal">
<div class="modal-content">
<h3>⚙️ 自动更新 - 端口配置</h3>
<div class="form-group">
<label class="form-label">请输入端口号</label>
<input type="number" class="form-input" id="custom-port-input" value="443" placeholder="例如: 443, 8443, 2053" onkeypress="if(event.key==='Enter') submitCustomPort()">
<div class="form-help">默认为 443，点击确认后将在新窗口打开</div>
</div>
<div class="modal-buttons">
<button class="button button-secondary" onclick="closePortModal()">取消</button>
<button class="button" onclick="submitCustomPort()">确认</button>
</div>
</div>
</div>

<script>
function setTheme(mode) {
localStorage.setItem('theme', mode);
applyTheme();
}

function applyTheme() {
const savedTheme = localStorage.getItem('theme') || 'system';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
let isDark = savedTheme === 'dark';
if (savedTheme === 'system') {
isDark = systemDark;
}
const body = document.body;
const sunIcon = document.querySelector('.sun-icon');
const moonIcon = document.querySelector('.moon-icon');
if (isDark) {
body.classList.add('dark-mode');
sunIcon.style.display = 'block';
moonIcon.style.display = 'none';
} else {
body.classList.remove('dark-mode');
sunIcon.style.display = 'none';
moonIcon.style.display = 'block';
}
}

function initTheme() {
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
if (localStorage.getItem('theme') === 'system' || !localStorage.getItem('theme')) {
applyTheme();
}
});
}

function getCountryFlag(countryCode) {
if (!countryCode || countryCode === 'XX') return '🌐';
const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
return String.fromCodePoint(...codePoints);
}

function getSourceName(url) {
try {
const urlObj = new URL(url);
return urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : '');
} catch (e) {
return url;
}
}

let tokenConfig = ${tokenConfig ? JSON.stringify(tokenConfig) : 'null'};
let updateController = null;

async function logout() {
try { await fetch('/auth-logout', { method: 'POST' }); location.reload(); } catch (e) { location.reload(); }
}

function openCustomPortLink() {
document.getElementById('port-modal').style.display = 'flex';
document.getElementById('custom-port-input').value = '443';
setTimeout(() => document.getElementById('custom-port-input').focus(), 100);
}

function closePortModal() {
document.getElementById('port-modal').style.display = 'none';
}

function submitCustomPort() {
let port = document.getElementById('custom-port-input').value;
port = port.trim();
if (!port) port = "443";
let url = '/cf-custom-port?port=' + port;
if (tokenConfig && tokenConfig.token) {
url += '&token=' + tokenConfig.token;
}
window.open(url, '_blank');
closePortModal();
}

function openTokenModal() {
document.getElementById('token-modal').style.display = 'flex';
if (tokenConfig) {
document.getElementById('token-input').value = tokenConfig.token;
const neverExpire = tokenConfig.neverExpire || false;
document.getElementById('never-expire-checkbox').checked = neverExpire;
if (neverExpire) {
document.getElementById('expires-group').style.display = 'none';
document.getElementById('expires-days').disabled = true;
} else {
document.getElementById('expires-group').style.display = 'block';
document.getElementById('expires-days').disabled = false;
const expires = new Date(tokenConfig.expires);
const today = new Date();
const diffTime = expires - today;
const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
document.getElementById('expires-days').value = diffDays > 0 ? diffDays : 30;
}
} else {
document.getElementById('token-input').value = '';
document.getElementById('never-expire-checkbox').checked = false;
document.getElementById('expires-group').style.display = 'block';
document.getElementById('expires-days').disabled = false;
document.getElementById('expires-days').value = 30;
}
}

function closeTokenModal() {
document.getElementById('token-modal').style.display = 'none';
}

function toggleExpireInput() {
const checkbox = document.getElementById('never-expire-checkbox');
const expiresGroup = document.getElementById('expires-group');
const expiresInput = document.getElementById('expires-days');
if (checkbox.checked) {
expiresGroup.style.display = 'none';
expiresInput.disabled = true;
} else {
expiresGroup.style.display = 'block';
expiresInput.disabled = false;
}
}

function generateRandomToken() {
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let result = '';
for (let i = 0; i < 32; i++) {
result += chars.charAt(Math.floor(Math.random() * chars.length));
}
document.getElementById('token-input').value = result;
}

async function saveTokenConfig() {
const token = document.getElementById('token-input').value.trim();
const neverExpire = document.getElementById('never-expire-checkbox').checked;
const expiresDays = neverExpire ? null : parseInt(document.getElementById('expires-days').value);
if (!token) {
showMessage('请输入Token字符串', 'error');
return;
}
if (!neverExpire && (!expiresDays || expiresDays < 1 || expiresDays > 365)) {
showMessage('请输入有效的过期天数（1-365）', 'error');
return;
}
try {
const response = await fetch('/admin-token', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ token, expiresDays, neverExpire })
});
const data = await response.json();
if (data.success) {
tokenConfig = data.tokenConfig;
showMessage('Token配置已保存', 'success');
closeTokenModal();
setTimeout(() => location.reload(), 1000);
} else {
showMessage(data.error, 'error');
}
} catch (error) {
showMessage('保存失败: ' + error.message, 'error');
}
}

async function clearTokenConfig() {
if(!confirm('⚠️ 确定要清除 Token 配置吗？清除后，Token 保护将被移除，您的接口将恢复为【公开访问】状态。')) return;
try {
const response = await fetch('/admin-token', { method: 'DELETE' });
const data = await response.json();
if (data.success) {
tokenConfig = null;
showMessage('Token 配置已清除，即将刷新...');
closeTokenModal();
setTimeout(() => location.reload(), 1000);
} else {
showMessage(data.error, 'error');
}
} catch (error) {
showMessage('请求失败: ' + error.message, 'error');
}
}

let speedResults = {};
let isTesting = false;
let currentTestIndex = 0;

function showMessage(message, type = 'success') {
const result = document.getElementById('result');
result.className = \`result \${type}\`;
result.innerHTML = \`<p>\${message}</p>\`;
result.style.display = 'block';
setTimeout(() => { result.style.display = 'none'; }, 3000);
}

function openItdogModal() {
document.getElementById('itdog-modal').style.display = 'flex';
}

function closeItdogModal() {
document.getElementById('itdog-modal').style.display = 'none';
}

async function copyIPsForItdog() {
try {
const response = await fetch('/itdog-data');
const data = await response.json();
if (data.ips && data.ips.length > 0) {
const ipText = data.ips.join('\\n');
await navigator.clipboard.writeText(ipText);
showMessage('已复制 IP 列表，请粘贴到 ITDog 网站');
closeItdogModal();
} else {
showMessage('没有可测速的IP地址', 'error');
}
} catch (error) {
console.error('获取 ITDog 数据失败:', error);
showMessage('获取 IP 列表失败', 'error');
}
}

function copyIP(ip) {
navigator.clipboard.writeText(ip).then(() => {
showMessage(\`已复制 IP: \${ip}\`);
}).catch(err => {
showMessage('复制失败，请手动复制', 'error');
});
}

function copyAllFastIPs() {
const ipItems = document.querySelectorAll('.ip-item span.ip-address');
const allIPs = Array.from(ipItems).map(span => span.textContent).join('\\n');
if (!allIPs) {
showMessage('没有可复制的优质IP地址', 'error');
return;
}
navigator.clipboard.writeText(allIPs).then(() => {
showMessage(\`已复制 \${ipItems.length} 个优质IP地址\`);
}).catch(err => {
showMessage('复制失败，请手动复制', 'error');
});
}

async function startSpeedTest() {
if (isTesting) {
showMessage('测速正在进行中，请稍候...', 'error');
return;
}
const ipItems = document.querySelectorAll('.ip-item');
if (ipItems.length === 0) {
showMessage('没有可测速的IP地址', 'error');
return;
}
const speedtestBtn = document.getElementById('speedtest-btn');
const progressBar = document.getElementById('speed-test-progress');
const progressBarInner = document.getElementById('speed-test-progress-bar');
const statusElement = document.getElementById('speed-test-status');
isTesting = true;
speedtestBtn.disabled = true;
speedtestBtn.textContent = '测速中...';
progressBar.style.display = 'block';
const totalIPs = ipItems.length;
currentTestIndex = 0;
document.querySelectorAll('.speed-result').forEach(el => {
el.textContent = '测试中...';
el.className = 'speed-result';
});
for (let i = 0; i < totalIPs; i++) {
if (!isTesting) break;
const ip = ipItems[i].dataset.ip;
statusElement.textContent = \`正在测速 \${i+1}/\${totalIPs}: \${ip}\`;
const startTime = performance.now();
try {
const response = await fetch(\`/speedtest?ip=\${ip}\`, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
const data = await response.json();
const endTime = performance.now();
const latency = endTime - startTime;
speedResults[ip] = { latency, success: data.success, time: data.time || '未知' };
const speedElement = document.getElementById(\`speed-\${ip.replace(/\./g, '-')}\`);
if (data.success) {
const speedClass = latency < 200 ? 'speed-fast' : latency < 500 ? 'speed-medium' : 'speed-slow';
speedElement.textContent = \`\${Math.round(latency)}ms\`;
speedElement.className = \`speed-result \${speedClass}\`;
} else {
speedElement.textContent = '失败';
speedElement.className = 'speed-result speed-slow';
}
} catch (error) {
const speedElement = document.getElementById(\`speed-\${ip.replace(/\./g, '-')}\`);
speedElement.textContent = '错误';
speedElement.className = 'speed-result speed-slow';
}
currentTestIndex = i + 1;
const progress = (currentTestIndex / totalIPs) * 100;
progressBarInner.style.width = \`\${progress}%\`;
await new Promise(resolve => setTimeout(resolve, 300));
}
isTesting = false;
speedtestBtn.disabled = false;
speedtestBtn.textContent = '⚡ 开始测速';
progressBar.style.display = 'none';
showMessage(\`测速完成，已测试 \${currentTestIndex} 个IP地址\`);
setTimeout(refreshData, 1000);
}

async function updateIPs() {
const btn = document.getElementById('update-btn');
const loading = document.getElementById('loading');
const result = document.getElementById('result');
if (updateController) {
updateController.abort();
updateController = null;
btn.innerHTML = '🔄 立即更新';
btn.classList.remove('button-warning');
loading.style.display = 'none';
showMessage('🛑 更新已手动停止', 'error');
return;
}
updateController = new AbortController();
const signal = updateController.signal;
btn.innerHTML = '🖐️ 停止更新';
btn.classList.add('button-warning');
loading.style.display = 'block';
result.style.display = 'none';
try {
const response = await fetch('/update', { method: 'POST', signal });
const data = await response.json();
if (data.success) {
result.className = 'result success';
result.innerHTML = \`<h3>✅ 更新成功！</h3><p>耗时: \${data.duration}</p><p>收集到 \${data.totalIPs} 个唯一 IP 地址</p><p>时间: \${new Date(data.timestamp).toLocaleString()}</p>\`;
} else {
result.className = 'result error';
result.innerHTML = \`<h3>❌ 更新失败</h3><p>\${data.error}</p>\`;
}
result.style.display = 'block';
setTimeout(refreshData, 1000);
} catch (error) {
if (error.name === 'AbortError') return;
result.className = 'result error';
result.innerHTML = \`<h3>❌ 请求失败</h3><p>\${error.message}</p>\`;
result.style.display = 'block';
} finally {
if (updateController && updateController.signal === signal) {
updateController = null;
btn.innerHTML = '🔄 立即更新';
btn.classList.remove('button-warning');
loading.style.display = 'none';
}
}
}

async function saveCustomSource() {
const input = document.getElementById('custom-source-input');
const url = input.value.trim();
if (!url) { showMessage('请输入有效的 URL', 'error'); return; }
try {
const response = await fetch('/save-custom-source', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ url })
});
const data = await response.json();
if (data.success) {
showMessage('自定义源已添加，请点击"立即更新"使其生效！');
input.value = '';
refreshData();
} else {
showMessage('添加失败: ' + data.error, 'error');
}
} catch (e) { showMessage('请求失败', 'error'); }
}

async function loadCustomSources(latestResults = []) {
try {
const response = await fetch('/get-custom-source');
const data = await response.json();
const container = document.getElementById('saved-custom-sources');
let sources = [];
if (data.list) { sources = data.list; }
else if (data.url) { sources = [data.url]; }
if (sources.length > 0) {
container.innerHTML = sources.map(url => {
const nameToCheck = getSourceName(url);
const statusObj = latestResults.find(r => r.name === nameToCheck);
let statusClass = '';
let statusText = '等待下次更新...';
if (statusObj) {
if (statusObj.status === 'success') { statusText = \`成功获取 \${statusObj.count} 个IP\`; }
else { statusClass = 'error'; statusText = \`失败: \${statusObj.error}\`; }
} else { statusText = '等待下次更新 (请点击立即更新)'; }
return \`<div class="source \${statusClass}" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;"><div style="flex: 1; overflow: hidden; margin-right: 10px;"><div style="font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">自定义源: \${url}</div><div style="font-size: 0.9rem; color: \${statusClass === 'error' ? '#991b1b' : '#065f46'};">\${statusText}</div></div><button class="delete-btn" style="flex-shrink: 0;" onclick="deleteSource('\${url}')">删除</button></div>\`;
}).join('');
} else {
container.innerHTML = '<p style="color: #64748b; font-size: 0.9rem;">暂无自定义源</p>';
}
} catch (e) { console.error('Failed to load custom sources', e); }
}

async function deleteSource(url) {
try {
const response = await fetch('/delete-custom-source', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ url })
});
const data = await response.json();
if (data.success) { showMessage('删除成功！'); refreshData(); }
else { showMessage('删除失败: ' + data.error, 'error'); }
} catch (e) { showMessage('请求失败', 'error'); }
}

async function refreshData() {
try {
const response = await fetch('/raw');
const data = await response.json();
document.getElementById('ip-count').textContent = data.count || 0;
document.getElementById('last-updated').textContent = data.lastUpdated ? '已更新' : '未更新';
if (data.lastUpdated) {
const d = new Date(data.lastUpdated);
const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const timeStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
document.getElementById('last-date').textContent = dateStr;
document.getElementById('last-time').textContent = timeStr;
} else {
document.getElementById('last-date').textContent = '----/--/--';
document.getElementById('last-time').textContent = '从未更新';
}
const fastResponse = await fetch('/fast-ips');
const fastData = await fastResponse.json();
document.getElementById('fast-ip-count').textContent = fastData.fastIPs ? fastData.fastIPs.length : 0;
const ipList = document.getElementById('ip-list');
if (fastData.fastIPs && fastData.fastIPs.length > 0) {
ipList.innerHTML = fastData.fastIPs.map(item => {
const ip = item.ip;
const latency = item.latency;
const location = item.location || {};
const speedClass = latency < 200 ? 'speed-fast' : latency < 500 ? 'speed-medium' : 'speed-slow';
const locationText = location.country ?
\`\${getCountryFlag(location.countryCode)} \${location.city || location.country}\${location.org ? ' · ' + location.org : ''}\` :
'📍 查询中...';
const locationClass = location.country ? '' : ' loading-location';
return \`<div class="ip-item" data-ip="\${ip}"><div class="ip-info"><span class="ip-address">\${ip}</span><span class="speed-result \${speedClass}" id="speed-\${ip.replace(/\./g, '-')}">\${latency}ms</span><span class="ip-location\${locationClass}" id="loc-\${ip.replace(/\./g, '-')}" title="\${location.country ? location.country + ' ' + (location.city || '') + ' | ' + (location.org || '') : '正在查询地理位置...'}">\${locationText}</span></div><div class="action-buttons"><button class="small-btn" onclick="copyIP('\${ip}')">复制</button></div></div>\`;
}).join('');
setTimeout(loadIPLocations, 500);
} else {
ipList.innerHTML = '<p style="text-align: center; color: #64748b; padding: 40px;">暂无优质 IP 地址数据，请点击更新按钮获取</p>';
}
const sources = document.getElementById('sources');
if (data.sources && data.sources.length > 0) {
sources.innerHTML = data.sources.map(source => \`<div class="source \${source.status === 'success' ? '' : 'error'}"><strong>\${source.name}</strong>: \${source.status === 'success' ? \`成功获取 \${source.count} 个IP\` : \`失败: \${source.error}\`}</div>\`).join('');
}
loadCustomSources(data.sources || []);
} catch (error) {
console.error('刷新数据失败:', error);
}
}

async function loadIPLocations() {
const ipItems = document.querySelectorAll('.ip-item');
const ipsToQuery = [];
ipItems.forEach(item => {
const ip = item.dataset.ip;
const locEl = document.getElementById('loc-' + ip.replace(/\./g, '-'));
if (!locEl) return;
// 有data-cc但没国旗的，补上国旗
const cc = locEl.dataset.cc;
if (cc && !locEl.textContent.startsWith('📍')) {
locEl.textContent = getCountryFlag(cc) + ' ' + locEl.textContent;
locEl.className = 'ip-location';
}
// 没有位置信息的，需要查询
if (!locEl.textContent.trim() || locEl.textContent.includes('查询中')) {
ipsToQuery.push({ ip, element: locEl });
}
});
if (ipsToQuery.length === 0) return;
const BATCH_SIZE = 5;
for (let i = 0; i < ipsToQuery.length; i += BATCH_SIZE) {
const batch = ipsToQuery.slice(i, i + BATCH_SIZE);
const promises = batch.map(async ({ ip, element }) => {
try {
const response = await fetch(\`https://ipapi.co/\${ip}/json/\`);
if (response.ok) {
const data = await response.json();
element.textContent = data.country_name ?
\`\${getCountryFlag(data.country_code)} \${data.city || data.region || data.country_name}\${data.org ? ' · ' + data.org : ''}\` :
'📍 未知';
element.className = 'ip-location';
element.title = \`\${data.country_name || ''} \${data.city || data.region || ''} | \${data.org || ''}\`;
} else {
element.textContent = '📍 查询失败';
element.className = 'ip-location';
}
} catch (e) {
element.textContent = '📍 网络错误';
element.className = 'ip-location';
}
});
await Promise.allSettled(promises);
if (i + BATCH_SIZE < ipsToQuery.length) {
await new Promise(resolve => setTimeout(resolve, 500));
}
}
}

document.addEventListener('DOMContentLoaded', function() {
refreshData();
initTheme();
});
</script>
</body>
</html>`;

return new Response(html, {
headers: {
'Content-Type': 'text/html; charset=utf-8',
}
});
}


// ========== 处理优质IP列表获取（JSON格式）==========
async function handleGetFastIPs(env) {
const data = await getStoredSpeedIPs(env);
return jsonResponse(data);
}

// ========== 处理优质IP列表获取（文本格式）==========
async function handleGetFastIPsText(env) {
const data = await getStoredSpeedIPs(env);
const fastIPs = data.fastIPs || [];
const ipList = fastIPs.map(item => `${item.ip}#${item.latency}ms`).join('\n');
return new Response(ipList, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Content-Disposition': 'inline; filename="cloudflare_fast_ips.txt"',
'Access-Control-Allow-Origin': '*'
}
});
}

// ========== EdgeTunnel版 (纯IP，一行一个) ==========
async function handleGetEdgeTunnelIPs(request, env) {
const tokenConfig = await getTokenConfig(env);
if (tokenConfig && tokenConfig.token) {
const url = new URL(request.url);
if (url.searchParams.get('token') !== tokenConfig.token) {
return new Response('需要管理员权限', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
}
const data = await getStoredSpeedIPs(env);
const fastIPs = data.fastIPs || [];
const ipList = fastIPs.map(item => item.ip).join('\n');
return new Response(ipList, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Content-Disposition': 'inline; filename="edgetunnel_ips.txt"',
'Access-Control-Allow-Origin': '*'
}
});
}

// ========== CFNew版 (IP:443，逗号分隔) ==========
async function handleGetCFNewIPs(request, env) {
const tokenConfig = await getTokenConfig(env);
if (tokenConfig && tokenConfig.token) {
const url = new URL(request.url);
if (url.searchParams.get('token') !== tokenConfig.token) {
return new Response('需要管理员权限', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
}
const data = await getStoredSpeedIPs(env);
const fastIPs = data.fastIPs || [];
const ipList = fastIPs.map(item => `${item.ip}:443`).join(',');
return new Response(ipList, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Content-Disposition': 'inline; filename="cfnew_ips.txt"',
'Access-Control-Allow-Origin': '*'
}
});
}

// ========== 自定义端口版 ==========
async function handleGetCFCustomPort(request, env) {
const tokenConfig = await getTokenConfig(env);
if (tokenConfig && tokenConfig.token) {
const url = new URL(request.url);
if (url.searchParams.get('token') !== tokenConfig.token) {
return new Response('需要管理员权限', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
}
const url = new URL(request.url);
const port = url.searchParams.get('port') || '443';
const data = await getStoredSpeedIPs(env);
const fastIPs = data.fastIPs || [];
const ipList = fastIPs.map(item => `${item.ip}:${port}#♾️·CFnew·${item.ip}`).join('\n');
return new Response(ipList, {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Content-Disposition': `inline; filename="cf_custom_${port}.txt"`,
'Access-Control-Allow-Origin': '*'
}
});
}

// ========== ITDog数据获取 ==========
async function handleItdogData(env) {
const data = await getStoredIPs(env);
return jsonResponse({ ips: data.ips || [], count: data.count || 0 });
}

// ========== 测速请求 ==========
async function handleSpeedTest(request, env) {
const url = new URL(request.url);
const ip = url.searchParams.get('ip');
if (!ip) return jsonResponse({ error: 'IP parameter is required' }, 400);
try {
const testUrl = `https://speed.cloudflare.com/__down?bytes=1000`;
const response = await fetch(testUrl, {
headers: { 'Host': 'speed.cloudflare.com' },
cf: { resolveOverride: ip }
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
await response.text();
return jsonResponse({ success: true, ip, time: new Date().toISOString() });
} catch (error) {
console.error(`Speed test failed for IP ${ip}:`, error);
return jsonResponse({ success: false, ip, error: error.message, time: new Date().toISOString() }, 500);
}
}

// ========== 手动更新 ==========
async function handleUpdate(env) {
try {
if (!env.IP_STORAGE) throw new Error('KV namespace IP_STORAGE is not bound. Please check your Worker settings.');
const startTime = Date.now();
const { uniqueIPs, results } = await updateAllIPs(env);
const duration = Date.now() - startTime;
await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
ips: uniqueIPs,
lastUpdated: new Date().toISOString(),
count: uniqueIPs.length,
sources: results
}));
await autoSpeedTestAndStore(env, uniqueIPs);
return jsonResponse({
success: true,
message: 'IPs collected and speed test completed successfully',
duration: `${duration}ms`,
totalIPs: uniqueIPs.length,
timestamp: new Date().toISOString(),
results
});
} catch (error) {
console.error('Update error:', error);
return jsonResponse({ success: false, error: error.message }, 500);
}
}

// ========== 自动测速并存储优质IP ==========
async function autoSpeedTestAndStore(env, ips) {
if (!ips || ips.length === 0) return;
const speedResults = [];
const BATCH_SIZE = 5;
const ipsToTest = ips.slice(0, AUTO_TEST_MAX_IPS);
console.log(`Starting auto speed test for ${ipsToTest.length} IPs (out of ${ips.length} total)...`);
for (let i = 0; i < ipsToTest.length; i += BATCH_SIZE) {
const batch = ipsToTest.slice(i, i + BATCH_SIZE);
const batchPromises = batch.map(ip => testIPSpeed(ip));
const batchResults = await Promise.allSettled(batchPromises);
for (let j = 0; j < batchResults.length; j++) {
const result = batchResults[j];
const ip = batch[j];
if (result.status === 'fulfilled') {
const speedData = result.value;
if (speedData.success && speedData.latency) {
speedResults.push({ ip, latency: Math.round(speedData.latency) });
}
}
}
if (i + BATCH_SIZE < ipsToTest.length) {
await new Promise(resolve => setTimeout(resolve, 500));
}
}
speedResults.sort((a, b) => a.latency - b.latency);
const fastIPs = speedResults.slice(0, FAST_IP_COUNT);

// 地理位置查询
if (GEO_LOCATION_ENABLED && fastIPs.length > 0) {
console.log(`Starting location lookup for ${fastIPs.length} fast IPs...`);
for (let i = 0; i < fastIPs.length; i += GEO_BATCH_SIZE) {
const batch = fastIPs.slice(i, i + GEO_BATCH_SIZE);
const locationPromises = batch.map(async (ipData) => {
ipData.location = await getIPLocation(ipData.ip);
return ipData;
});
await Promise.allSettled(locationPromises);
if (i + GEO_BATCH_SIZE < fastIPs.length) {
await new Promise(resolve => setTimeout(resolve, 500));
}
}
}

await env.IP_STORAGE.put('cloudflare_fast_ips', JSON.stringify({
fastIPs,
lastTested: new Date().toISOString(),
count: fastIPs.length,
testedCount: speedResults.length,
totalIPs: ips.length
}));
console.log(`Auto speed test completed. Found ${fastIPs.length} fast IPs out of ${speedResults.length} tested.`);
}

// ========== 测试单个IP速度 ==========
async function testIPSpeed(ip) {
try {
const startTime = Date.now();
const testUrl = `https://speed.cloudflare.com/__down?bytes=1000`;
const response = await fetch(testUrl, {
headers: { 'Host': 'speed.cloudflare.com' },
cf: { resolveOverride: ip },
signal: AbortSignal.timeout(3000)
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
await response.text();
const endTime = Date.now();
return { success: true, ip, latency: endTime - startTime };
} catch (error) {
return { success: false, ip, error: error.message };
}
}

// 获取IP地理位置
async function getIPLocation(ip) {
try {
const response = await fetch(`https://ipapi.co/${ip}/json/`, {
headers: { 'User-Agent': 'Cloudflare-IP-Collector/1.0' },
signal: AbortSignal.timeout(5000)
});
if (!response.ok) return { country: '', countryCode: '', city: '', region: '', org: '', error: `HTTP ${response.status}` };
const data = await response.json();
return { country: data.country_name || '', countryCode: data.country_code || '', city: data.city || '', region: data.region || '', org: data.org || '', timezone: data.timezone || '' };
} catch (error) {
return { country: '', countryCode: '', city: '', region: '', org: '', error: error.message };
}
}

// ========== 获取IP列表 ==========
async function handleGetIPs(env) {
const data = await getStoredIPs(env);
return new Response(data.ips.join('\n'), {
headers: {
'Content-Type': 'text/plain; charset=utf-8',
'Content-Disposition': 'inline; filename="cloudflare_ips.txt"',
'Access-Control-Allow-Origin': '*'
}
});
}

// ========== 获取原始数据 ==========
async function handleRawIPs(env) {
const data = await getStoredIPs(env);
return jsonResponse(data);
}

// ========== 保存自定义来源 ==========
async function handleSaveCustomSource(request, env) {
try {
const body = await request.json();
if (body.url) {
let currentList = [];
try {
const stored = await env.IP_STORAGE.get('custom_source_list');
if (stored) currentList = JSON.parse(stored);
} catch(e) { currentList = []; }
if (!currentList.includes(body.url)) {
currentList.push(body.url);
await env.IP_STORAGE.put('custom_source_list', JSON.stringify(currentList));
}
return jsonResponse({ success: true });
}
return jsonResponse({ error: 'URL is required' }, 400);
} catch (e) {
return jsonResponse({ error: e.message }, 500);
}
}

// ========== 获取自定义来源 ==========
async function handleGetCustomSource(env) {
const listStr = await env.IP_STORAGE.get('custom_source_list');
if (listStr) return jsonResponse({ list: JSON.parse(listStr) });
const url = await env.IP_STORAGE.get('custom_source_url');
return jsonResponse({ url: url || '' });
}

// ========== 删除自定义来源 ==========
async function handleDeleteCustomSource(request, env) {
try {
const body = await request.json();
if (body.url) {
let currentList = [];
try {
const stored = await env.IP_STORAGE.get('custom_source_list');
if (stored) currentList = JSON.parse(stored);
} catch(e) { currentList = []; }
const newList = currentList.filter(u => u !== body.url);
await env.IP_STORAGE.put('custom_source_list', JSON.stringify(newList));
return jsonResponse({ success: true });
}
return jsonResponse({ error: 'URL is required' }, 400);
} catch (e) {
return jsonResponse({ error: e.message }, 500);
}
}

// ========== 主要的IP收集逻辑 ==========
async function updateAllIPs(env) {
const urls = [
'https://ip.164746.xyz',
'https://ip.haogege.xyz/',
'https://stock.hostmonit.com/CloudFlareYes',
'https://api.uouin.com/cloudflare.html',
'https://addressesapi.090227.xyz/CloudFlareYes',
'https://addressesapi.090227.xyz/ip.164746.xyz',
'https://www.wetest.vip/page/cloudflare/address_v4.html'
];
try {
const customUrl = await env.IP_STORAGE.get('custom_source_url');
if (customUrl && customUrl.startsWith('http')) {
console.log('Adding legacy custom source:', customUrl);
urls.push(customUrl);
}
const customListStr = await env.IP_STORAGE.get('custom_source_list');
if (customListStr) {
const customList = JSON.parse(customListStr);
if (Array.isArray(customList)) {
customList.forEach(url => {
if (url && url.startsWith('http')) {
console.log('Adding custom source from list:', url);
urls.push(url);
}
});
}
}
} catch (e) {
console.error('Failed to load custom sources:', e);
}

const uniqueIPs = new Set();
const results = [];
const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/gi;
const BATCH_SIZE = 3;
for (let i = 0; i < urls.length; i += BATCH_SIZE) {
const batch = urls.slice(i, i + BATCH_SIZE);
const batchPromises = batch.map(url => fetchURLWithTimeout(url, 8000));
const batchResults = await Promise.allSettled(batchPromises);
for (let j = 0; j < batchResults.length; j++) {
const result = batchResults[j];
const url = batch[j];
const sourceName = getSourceName(url);
if (result.status === 'fulfilled') {
const content = result.value;
const ipMatches = content.match(ipPattern) || [];
ipMatches.forEach(ip => {
if (isValidIPv4(ip)) uniqueIPs.add(ip);
});
results.push({ name: sourceName, status: 'success', count: ipMatches.length, error: null });
console.log(`Successfully collected ${ipMatches.length} IPs from ${sourceName}`);
} else {
console.error(`Failed to fetch ${sourceName}:`, result.reason);
results.push({ name: sourceName, status: 'error', count: 0, error: result.reason.message });
}
}
if (i + BATCH_SIZE < urls.length) {
await new Promise(resolve => setTimeout(resolve, 1000));
}
}
const sortedIPs = Array.from(uniqueIPs).sort((a, b) => {
const aParts = a.split('.').map(part => parseInt(part, 10));
const bParts = b.split('.').map(part => parseInt(part, 10));
for (let i = 0; i < 4; i++) {
if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
}
return 0;
});
return { uniqueIPs: sortedIPs, results };
}

function getSourceName(url) {
try {
const urlObj = new URL(url);
return urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : '');
} catch (e) { return url; }
}

function fetchURLWithTimeout(url, timeout = 8000) {
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeout);
return fetch(url, {
signal: controller.signal,
headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-IP-Collector/1.0)', 'Accept': 'text/html,application/json,text/plain,*/*' }
}).then(async (response) => {
if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
return await response.text();
}).finally(() => { clearTimeout(timeoutId); });
}

async function getStoredIPs(env) {
try {
if (!env.IP_STORAGE) { console.error('KV namespace IP_STORAGE is not bound'); return getDefaultData(); }
const data = await env.IP_STORAGE.get('cloudflare_ips');
if (data) return JSON.parse(data);
} catch (error) { console.error('Error reading from KV:', error); }
return getDefaultData();
}

async function getStoredSpeedIPs(env) {
try {
if (!env.IP_STORAGE) { console.error('KV namespace IP_STORAGE is not bound'); return getDefaultSpeedData(); }
const data = await env.IP_STORAGE.get('cloudflare_fast_ips');
if (data) return JSON.parse(data);
} catch (error) { console.error('Error reading speed IPs from KV:', error); }
return getDefaultSpeedData();
}

function getDefaultData() { return { ips: [], lastUpdated: null, count: 0, sources: [] }; }
function getDefaultSpeedData() { return { fastIPs: [], lastTested: null, count: 0 }; }

function isValidIPv4(ip) {
const parts = ip.split('.');
if (parts.length !== 4) return false;
for (const part of parts) {
const num = parseInt(part, 10);
if (isNaN(num) || num < 0 || num > 255) return false;
if (part.startsWith('0') && part.length > 1) return false;
}
if (ip.startsWith('10.') || ip.startsWith('192.168.') ||
(ip.startsWith('172.') && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) ||
ip.startsWith('127.') || ip.startsWith('169.254.') || ip === '255.255.255.255') return false;
return true;
}

function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data, null, 2), {
status,
headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
});
}

function handleCORS() {
return new Response(null, {
headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
});
}

// ========== 鉴权相关 ==========
async function sha256(text) {
const msgBuffer = new TextEncoder().encode(text);
const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
const hashArray = Array.from(new Uint8Array(hashBuffer));
return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAuthCookie(cookieHeader, correctPassword) {
if (!cookieHeader) return false;
const cookies = Object.fromEntries(cookieHeader.split('; ').map(c => c.split('=')));
const token = cookies['cf_ip_auth'];
if (!token) return false;
const expectedToken = await sha256(correctPassword);
return token === expectedToken;
}

async function handleLoginRequest(request, env, clientIP) {
if (!env.IP_STORAGE) return jsonResponse({ success: false, message: '系统错误: IP_STORAGE 未绑定' }, 500);
const lockKey = `login_fail:${clientIP}`;
const lockData = await env.IP_STORAGE.get(lockKey, { type: 'json' });
if (lockData && lockData.count >= 3) {
const now = Date.now();
if (now < lockData.blockedUntil) return jsonResponse({ success: false, message: '尝试次数过多，IP已被锁定24小时。' }, 403);
else await env.IP_STORAGE.delete(lockKey);
}
try {
const body = await request.json();
const inputPassword = body.password || '';
if (inputPassword === env.password) {
await env.IP_STORAGE.delete(lockKey);
const token = await sha256(env.password);
const headers = new Headers();
headers.append('Set-Cookie', `cf_ip_auth=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax; Secure`);
return new Response(JSON.stringify({ success: true }), {
headers: { 'Content-Type': 'application/json', ...Object.fromEntries(headers) }
});
} else {
const currentCount = (lockData ? lockData.count : 0) + 1;
const remaining = 3 - currentCount;
let storeData = { count: currentCount, blockedUntil: 0 };
if (currentCount >= 3) {
storeData.blockedUntil = Date.now() + 24 * 60 * 60 * 1000;
await env.IP_STORAGE.put(lockKey, JSON.stringify(storeData), { expirationTtl: 86500 });
return jsonResponse({ success: false, message: '密码错误，已被锁定24小时！' }, 403);
} else {
await env.IP_STORAGE.put(lockKey, JSON.stringify(storeData), { expirationTtl: 86400 });
return jsonResponse({ success: false, message: `密码错误，还剩${remaining}次尝试机会` }, 401);
}
}
} catch (e) {
return jsonResponse({ success: false, message: '请求格式错误' }, 400);
}
}

async function serveAuthPage(env) {
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloudflare IP 收集器 - 登录</title>
<style>
:root { --bg-color: #f8fafc; --card-bg: white; --text-color: #334155; --border-color: #e2e8f0; }
@media (prefers-color-scheme: dark) { :root { --bg-color: #0f172a; --card-bg: #1e293b; --text-color: #cbd5e1; --border-color: #334155; } }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-color); color: var(--text-color); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
.login-card { background: var(--card-bg); padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); width: 100%; max-width: 400px; text-align: center; border: 1px solid var(--border-color); }
h1 { color: #3b82f6; margin-bottom: 10px; font-size: 1.8rem; }
p { color: #64748b; margin-bottom: 30px; font-size: 0.95rem; }
input { width: 100%; padding: 12px 16px; border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 20px; font-size: 1rem; outline: none; background: var(--bg-color); color: var(--text-color); transition: border-color 0.2s; }
input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
button { width: 100%; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
button:hover { background: #2563eb; }
button:disabled { opacity: 0.7; cursor: not-allowed; }
.error-msg { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 8px; margin-top: 20px; font-size: 0.9rem; display: none; border: 1px solid #fecaca; }
</style>
</head>
<body>
<div class="login-card">
<h1>Cloudflare IP 收集器 UI+</h1>
<p>请输入管理员密码访问此页面</p>
<input type="password" id="password" placeholder="输入管理员密码" onkeypress="if(event.key==='Enter') doLogin()">
<button onclick="doLogin()" id="loginBtn">登录</button>
<div class="error-msg" id="errorMsg"></div>
</div>
<script>
async function doLogin() {
const pwd = document.getElementById('password').value;
const btn = document.getElementById('loginBtn');
const msg = document.getElementById('errorMsg');
if(!pwd) return;
btn.disabled = true;
btn.innerText = '验证中...';
msg.style.display = 'none';
try {
const res = await fetch('/auth-login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pwd}) });
const data = await res.json();
if(data.success) { location.reload(); }
else { msg.innerText = data.message; msg.style.display = 'block'; btn.disabled = false; btn.innerText = '登录'; }
} catch(e) { msg.innerText = '网络错误，请重试'; msg.style.display = 'block'; btn.disabled = false; btn.innerText = '登录'; }
}
</script>
</body>
</html>`;
return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ========== Token管理 ==========
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
const tokenConfig = { token: token.trim(), expires: expiresDate, createdAt: new Date().toISOString(), lastUsed: null, neverExpire: neverExpire || false };
await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));
return jsonResponse({ success: true, tokenConfig, message: 'Token更新成功' });
} catch (error) { return jsonResponse({ error: error.message }, 500); }
} else if (request.method === 'DELETE') {
try {
await env.IP_STORAGE.delete('token_config');
return jsonResponse({ success: true, message: 'Token配置已清除' });
} catch (error) { return jsonResponse({ error: error.message }, 500); }
} else {
return jsonResponse({ error: 'Method not allowed' }, 405);
}
}

async function getTokenConfig(env) {
try {
const config = await env.IP_STORAGE.get('token_config');
return config ? JSON.parse(config) : null;
} catch (error) { return null; }
}
