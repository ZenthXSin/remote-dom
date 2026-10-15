import type {MirrorNode} from './protocol.js';

// Only resource-bearing fields may schedule a download. Text and input values
// can be large and can contain literal "asset:" strings that are not resources.
export function collectNodeAssets(nodes:readonly MirrorNode[],ids=new Set<string>()):Set<string> {
  const scan=(value:string|undefined)=>{if(value?.includes('asset:'))for(const match of value.matchAll(/asset:([a-f0-9-]{36})(?![a-f0-9-])/g))ids.add(match[1]);};
  const styles=(values:Record<string,string>|undefined)=>{if(values)for(const value of Object.values(values))scan(value);};
  for(const node of nodes){scan(node.assetUrl);styles(node.style);styles(node.backdropStyle);if(node.pseudoStyles)for(const style of Object.values(node.pseudoStyles))styles(style);}
  return ids;
}
