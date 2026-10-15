import {STYLE_DEFAULTS,STYLE_PROPERTIES,type MirrorNode} from '../shared/protocol.js';

// Preserve unrelated CSS rules across small DOM patches. Removing/recreating the
// whole sheet on every streamed character caused needless style recalculation.
export class MirrorRules {
  private rules=new Map<string,Map<string,{rule:CSSStyleRule;signature:string}>>();
  private allowed=new Set<string>(STYLE_PROPERTIES);
  constructor(private sheet:CSSStyleSheet,private resolve:(value:string)=>string|undefined){}
  sync(record:MirrorNode,assetVersion:number){
    let entries=this.rules.get(record.id);
    for(const pseudo of ['before','after','placeholder','backdrop'] as const){
      const declaration=pseudo==='backdrop'?(record.topLayer?record.backdropStyle??{}:undefined):record.pseudoStyles?.[pseudo];
      const cached=entries?.get(pseudo);
      if(!declaration){if(cached){this.drop(cached.rule);entries!.delete(pseudo);}continue;}
      const signature=JSON.stringify(declaration)+'@'+assetVersion;if(cached?.signature===signature)continue;
      let rule=cached?.rule;
      if(!rule){const attr=pseudo==='backdrop'?'data-rd-layer':'data-rd-node';const index=this.sheet.insertRule(`[${attr}="${record.id}"]::${pseudo} {}`,this.sheet.cssRules.length);rule=this.sheet.cssRules[index] as CSSStyleRule;}
      rule.style.cssText='';for(const [key,value]of Object.entries({...STYLE_DEFAULTS,...declaration})){if(!this.allowed.has(key))continue;const safe=this.resolve(value);if(safe!==undefined)rule.style.setProperty(key,safe);}
      if(!entries){entries=new Map();this.rules.set(record.id,entries);}entries.set(pseudo,{rule,signature});
    }
    if(entries&&!entries.size)this.rules.delete(record.id);
  }
  remove(id:string){for(const cached of this.rules.get(id)?.values()??[])this.drop(cached.rule);this.rules.delete(id);}
  clear(){this.rules.clear();while(this.sheet.cssRules.length)this.sheet.deleteRule(0);}
  private drop(rule:CSSStyleRule){for(let index=0;index<this.sheet.cssRules.length;index++)if(this.sheet.cssRules[index]===rule){this.sheet.deleteRule(index);return;}}
}
