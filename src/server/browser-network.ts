// HTTP proxies resolve destination names themselves. Prevent Chromium's
// speculative/system DNS from independently resolving external destinations.
// Keep only the configured proxy and exact local fixture hosts resolvable.
export function proxyHostResolverRules(proxyServer:string,fixtureOrigins:Iterable<string>):string {
  const hosts=new Set([new URL(proxyServer).hostname,...[...fixtureOrigins].map(origin=>new URL(origin).hostname)]);
  for(const host of hosts)if(!/^[a-z0-9.:[\]-]+$/i.test(host))throw new Error('Invalid proxy or fixture hostname');
  return ['MAP * ~NOTFOUND',...[...hosts].map(host=>`EXCLUDE ${host}`)].join(', ');
}
