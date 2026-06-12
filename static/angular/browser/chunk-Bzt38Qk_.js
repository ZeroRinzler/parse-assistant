import {w,_ as _n$1,$,i as ie,a7 as x,N as EI,P as wl,a_ as gr$1,a5 as Cv,a2 as lr$1,a$ as TI,b0 as Uf,ay as GE,d as op,az as hp,ae as Le$1,a1 as BP,aM as he,aq as Ug,b1 as _I,b2 as In$1,X as Ba,b3 as An$1,a4 as yt$1,b4 as Ce,b5 as jP,r as rD,b6 as VP,b7 as fs,a as _o,a9 as ee$1,a8 as nu,a3 as Hr,b8 as gu,ab as Hh,ag as mt$1,b9 as Fh,af as Sn$1,aj as $h,ad as Mh,ba as qP,v as vI,bb as Vn$1,at as sE,av as qf,o as oi$1,H as HI,aJ as aE,y as yc,g as Hy,B as BI,bc as up,aA as cp,bd as dE,aB as lE,aC as uE,be as lp,aD as ap,bf as cs,aH as So,ar as UP,aK as np,ax as Yf,e as ea,t as ta,n as Oo,I as Io,O as OE,J as Jf,bg as CI,bh as M,bi as io,bj as $e$1,bk as q$1,bl as oD,aT as Xf,aS as vc,aU as Ic,f as oE,k as Kf,aw as fE,bm as or$1,aE as V,bn as ht$1,bo as j,bp as cr$1,bq as am,U,E as Ep,br as _h,bs as hc,bt as we,bu as M$1,bv as jh,b,bw as eD}from'./main-XDRW463C.js';var dn=(()=>{class n{_renderer;_elementRef;onChange=e=>{};onTouched=()=>{};constructor(e,i){this._renderer=e,this._elementRef=i;}setProperty(e,i){this._renderer.setProperty(this._elementRef.nativeElement,e,i);}registerOnTouched(e){this.onTouched=e;}registerOnChange(e){this.onChange=e;}setDisabledState(e){this.setProperty("disabled",e);}static \u0275fac=function(i){return new(i||n)(gr$1(Cv),gr$1(lr$1))};static \u0275dir=TI({type:n})}return n})(),Jn=(()=>{class n extends dn{static \u0275fac=(()=>{let e;return function(r){return (e||(e=am(n)))(r||n)}})();static \u0275dir=TI({type:n,features:[Uf]})}return n})(),cn=new x("");var ei={provide:cn,useExisting:io(()=>un),multi:true};function ti(){let n=M()?M().getUserAgent():"";return /android (\d+)/.test(n.toLowerCase())}var ni=new x(""),un=(()=>{class n extends dn{_compositionMode;_composing=false;constructor(e,i,r){super(e,i),this._compositionMode=r,this._compositionMode==null&&(this._compositionMode=!ti());}writeValue(e){let i=e??"";this.setProperty("value",i);}_handleInput(e){(!this._compositionMode||this._compositionMode&&!this._composing)&&this.onChange(e);}_compositionStart(){this._composing=true;}_compositionEnd(e){this._composing=false,this._compositionMode&&this.onChange(e);}static \u0275fac=function(i){return new(i||n)(gr$1(Cv),gr$1(lr$1),gr$1(ni,8))};static \u0275dir=TI({type:n,selectors:[["input","formControlName","",3,"type","checkbox",3,"ngNoCva",""],["textarea","formControlName","",3,"ngNoCva",""],["input","formControl","",3,"type","checkbox",3,"ngNoCva",""],["textarea","formControl","",3,"ngNoCva",""],["input","ngModel","",3,"type","checkbox",3,"ngNoCva",""],["textarea","ngModel","",3,"ngNoCva",""],["","ngDefaultControl",""]],hostBindings:function(i,r){i&1&&op("input",function(a){return r._handleInput(a.target.value)})("blur",function(){return r.onTouched()})("compositionstart",function(){return r._compositionStart()})("compositionend",function(a){return r._compositionEnd(a.target.value)});},standalone:false,features:[GE([ei]),Uf]})}return n})();function lt(n){return n==null||dt(n)===0}function dt(n){return n==null?null:Array.isArray(n)||typeof n=="string"?n.length:n instanceof Set?n.size:null}var Ue=new x(""),ct=new x(""),ii=/^(?=.{1,254}$)(?=.{1,64}@)[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,xe=class{static min(t){return ri(t)}static max(t){return oi(t)}static required(t){return mn(t)}static requiredTrue(t){return ai(t)}static email(t){return si(t)}static minLength(t){return li(t)}static maxLength(t){return di(t)}static pattern(t){return ci(t)}static nullValidator(t){return Oe()}static compose(t){return vn(t)}static composeAsync(t){return bn(t)}};function ri(n){return t=>{if(t.value==null||n==null)return null;let e=parseFloat(t.value);return !isNaN(e)&&e<n?{min:{min:n,actual:t.value}}:null}}function oi(n){return t=>{if(t.value==null||n==null)return null;let e=parseFloat(t.value);return !isNaN(e)&&e>n?{max:{max:n,actual:t.value}}:null}}function mn(n){return lt(n.value)?{required:true}:null}function ai(n){return n.value===true?null:{required:true}}function si(n){return lt(n.value)||ii.test(n.value)?null:{email:true}}function li(n){return t=>{let e=t.value?.length??dt(t.value);return e===null||e===0?null:e<n?{minlength:{requiredLength:n,actualLength:e}}:null}}function di(n){return t=>{let e=t.value?.length??dt(t.value);return e!==null&&e>n?{maxlength:{requiredLength:n,actualLength:e}}:null}}function ci(n){if(!n)return Oe;let t,e;return typeof n=="string"?(e="",n.charAt(0)!=="^"&&(e+="^"),e+=n,n.charAt(n.length-1)!=="$"&&(e+="$"),t=new RegExp(e)):(e=n.toString(),t=n),i=>{if(lt(i.value))return null;let r=i.value;return t.test(r)?null:{pattern:{requiredPattern:e,actualValue:r}}}}function Oe(n){return null}function fn(n){return n!=null}function hn(n){return hc(n)?we(n):n}function pn(n){let t={};return n.forEach(e=>{t=e!=null?$($({},t),e):t;}),Object.keys(t).length===0?null:t}function gn(n,t){return t.map(e=>e(n))}function ui(n){return !n.validate}function _n(n){return n.map(t=>ui(t)?t:e=>t.validate(e))}function vn(n){if(!n)return null;let t=n.filter(fn);return t.length==0?null:function(e){return pn(gn(e,t))}}function ut(n){return n!=null?vn(_n(n)):null}function bn(n){if(!n)return null;let t=n.filter(fn);return t.length==0?null:function(e){let i=gn(e,t).map(hn);return _h(i).pipe(mt$1(pn))}}function mt(n){return n!=null?bn(_n(n)):null}function en(n,t){return n===null?[t]:Array.isArray(n)?[...n,t]:[n,t]}function yn(n){return n._rawValidators}function xn(n){return n._rawAsyncValidators}function ot(n){return n?Array.isArray(n)?n:[n]:[]}function Ne(n,t){return Array.isArray(n)?n.includes(t):n===t}function tn(n,t){let e=ot(t);return ot(n).forEach(r=>{Ne(e,r)||e.push(r);}),e}function nn(n,t){return ot(t).filter(e=>!Ne(n,e))}var Pe=class{get value(){return this.control?this.control.value:null}get valid(){return this.control?this.control.valid:null}get invalid(){return this.control?this.control.invalid:null}get pending(){return this.control?this.control.pending:null}get disabled(){return this.control?this.control.disabled:null}get enabled(){return this.control?this.control.enabled:null}get errors(){return this.control?this.control.errors:null}get pristine(){return this.control?this.control.pristine:null}get dirty(){return this.control?this.control.dirty:null}get touched(){return this.control?this.control.touched:null}get status(){return this.control?this.control.status:null}get untouched(){return this.control?this.control.untouched:null}get statusChanges(){return this.control?this.control.statusChanges:null}get valueChanges(){return this.control?this.control.valueChanges:null}get path(){return null}_composedValidatorFn;_composedAsyncValidatorFn;_rawValidators=[];_rawAsyncValidators=[];_setValidators(t){this._rawValidators=t||[],this._composedValidatorFn=ut(this._rawValidators);}_setAsyncValidators(t){this._rawAsyncValidators=t||[],this._composedAsyncValidatorFn=mt(this._rawAsyncValidators);}get validator(){return this._composedValidatorFn||null}get asyncValidator(){return this._composedAsyncValidatorFn||null}_onDestroyCallbacks=[];_registerOnDestroy(t){this._onDestroyCallbacks.push(t);}_invokeOnDestroyCallbacks(){this._onDestroyCallbacks.forEach(t=>t()),this._onDestroyCallbacks=[];}reset(t=void 0){this.control?.reset(t);}hasError(t,e){return this.control?this.control.hasError(t,e):false}getError(t,e){return this.control?this.control.getError(t,e):null}},J=class extends Pe{name;get formDirective(){return null}get path(){return null}};var ge="VALID",ke="INVALID",le="PENDING",_e="DISABLED",q=class{},Le=class extends q{value;source;constructor(t,e){super(),this.value=t,this.source=e;}},be=class extends q{pristine;source;constructor(t,e){super(),this.pristine=t,this.source=e;}},ye=class extends q{touched;source;constructor(t,e){super(),this.touched=t,this.source=e;}},de=class extends q{status;source;constructor(t,e){super(),this.status=t,this.source=e;}},Be=class extends q{source;constructor(t){super(),this.source=t;}},ce=class extends q{source;constructor(t){super(),this.source=t;}};function Cn(n){return ($e(n)?n.validators:n)||null}function mi(n){return Array.isArray(n)?ut(n):n||null}function Dn(n,t){return ($e(t)?t.asyncValidators:n)||null}function fi(n){return Array.isArray(n)?mt(n):n||null}function $e(n){return n!=null&&!Array.isArray(n)&&typeof n=="object"}function hi(n,t,e){let i=n.controls;if(!(Object.keys(i)).length)throw new b(1e3,"");if(!wn(i,e))throw new b(1001,"")}function pi(n,t,e){n._forEachChild((i,r)=>{if(e[r]===void 0)throw new b(-1002,"")});}var je=class{_pendingDirty=false;_hasOwnPendingAsyncValidator=null;_pendingTouched=false;_onCollectionChange=()=>{};_updateOn;_hasRequired=_o(false);_parent=null;_asyncValidationSubscription;_composedValidatorFn;_composedAsyncValidatorFn;_rawValidators;_rawAsyncValidators;value;constructor(t,e){this._assignValidators(t),this._assignAsyncValidators(e);}get validator(){return this._composedValidatorFn}set validator(t){this._rawValidators=this._composedValidatorFn=t,this._updateHasRequiredValidator();}get asyncValidator(){return this._composedAsyncValidatorFn}set asyncValidator(t){this._rawAsyncValidators=this._composedAsyncValidatorFn=t;}get parent(){return this._parent}get status(){return oD(this.statusReactive)}set status(t){oD(()=>this.statusReactive.set(t));}_status=rD(()=>this.statusReactive());statusReactive=_o(void 0);get valid(){return this.status===ge}get invalid(){return this.status===ke}get pending(){return this.status===le}get disabled(){return this.status===_e}get enabled(){return this.status!==_e}errors;get pristine(){return oD(this.pristineReactive)}set pristine(t){oD(()=>this.pristineReactive.set(t));}_pristine=rD(()=>this.pristineReactive());pristineReactive=_o(true);get dirty(){return !this.pristine}get touched(){return oD(this.touchedReactive)}set touched(t){oD(()=>this.touchedReactive.set(t));}_touched=rD(()=>this.touchedReactive());touchedReactive=_o(false);get untouched(){return !this.touched}_events=new ee$1;events=this._events.asObservable();valueChanges;statusChanges;get updateOn(){return this._updateOn?this._updateOn:this.parent?this.parent.updateOn:"change"}setValidators(t){this._assignValidators(t);}setAsyncValidators(t){this._assignAsyncValidators(t);}addValidators(t){this.setValidators(tn(t,this._rawValidators));}addAsyncValidators(t){this.setAsyncValidators(tn(t,this._rawAsyncValidators));}removeValidators(t){this.setValidators(nn(t,this._rawValidators));}removeAsyncValidators(t){this.setAsyncValidators(nn(t,this._rawAsyncValidators));}hasValidator(t){return Ne(this._rawValidators,t)}hasAsyncValidator(t){return Ne(this._rawAsyncValidators,t)}clearValidators(){this.validator=null;}clearAsyncValidators(){this.asyncValidator=null;}markAsTouched(t={}){let e=this.touched===false;this.touched=true;let i=t.sourceControl??this;t.onlySelf||this._parent?.markAsTouched(U($({},t),{sourceControl:i})),e&&t.emitEvent!==false&&this._events.next(new ye(true,i));}markAllAsDirty(t={}){this.markAsDirty({onlySelf:true,emitEvent:t.emitEvent,sourceControl:this}),this._forEachChild(e=>e.markAllAsDirty(t));}markAllAsTouched(t={}){this.markAsTouched({onlySelf:true,emitEvent:t.emitEvent,sourceControl:this}),this._forEachChild(e=>e.markAllAsTouched(t));}markAsUntouched(t={}){let e=this.touched===true;this.touched=false,this._pendingTouched=false;let i=t.sourceControl??this;this._forEachChild(r=>{r.markAsUntouched({onlySelf:true,emitEvent:t.emitEvent,sourceControl:i});}),t.onlySelf||this._parent?._updateTouched(t,i),e&&t.emitEvent!==false&&this._events.next(new ye(false,i));}markAsDirty(t={}){let e=this.pristine===true;this.pristine=false;let i=t.sourceControl??this;t.onlySelf||this._parent?.markAsDirty(U($({},t),{sourceControl:i})),e&&t.emitEvent!==false&&this._events.next(new be(false,i));}markAsPristine(t={}){let e=this.pristine===false;this.pristine=true,this._pendingDirty=false;let i=t.sourceControl??this;this._forEachChild(r=>{r.markAsPristine({onlySelf:true,emitEvent:t.emitEvent});}),t.onlySelf||this._parent?._updatePristine(t,i),e&&t.emitEvent!==false&&this._events.next(new be(true,i));}markAsPending(t={}){this.status=le;let e=t.sourceControl??this;t.emitEvent!==false&&(this._events.next(new de(this.status,e)),this.statusChanges.emit(this.status)),t.onlySelf||this._parent?.markAsPending(U($({},t),{sourceControl:e}));}disable(t={}){let e=this._parentMarkedDirty(t.onlySelf);this.status=_e,this.errors=null,this._forEachChild(r=>{r.disable(U($({},t),{onlySelf:true}));}),this._updateValue();let i=t.sourceControl??this;t.emitEvent!==false&&(this._events.next(new Le(this.value,i)),this._events.next(new de(this.status,i)),this.valueChanges.emit(this.value),this.statusChanges.emit(this.status)),this._updateAncestors(U($({},t),{skipPristineCheck:e}),this),this._onDisabledChange.forEach(r=>r(true));}enable(t={}){let e=this._parentMarkedDirty(t.onlySelf);this.status=ge,this._forEachChild(i=>{i.enable(U($({},t),{onlySelf:true}));}),this.updateValueAndValidity({onlySelf:true,emitEvent:t.emitEvent}),this._updateAncestors(U($({},t),{skipPristineCheck:e}),this),this._onDisabledChange.forEach(i=>i(false));}_updateAncestors(t,e){t.onlySelf||(this._parent?.updateValueAndValidity(t),t.skipPristineCheck||this._parent?._updatePristine({},e),this._parent?._updateTouched({},e));}setParent(t){this._parent=t;}getRawValue(){return this.value}updateValueAndValidity(t={}){if(this._setInitialStatus(),this._updateValue(),this.enabled){let i=this._cancelExistingSubscription();this.errors=this._runValidator(),this.status=this._calculateStatus(),(this.status===ge||this.status===le)&&this._runAsyncValidator(i,t.emitEvent);}let e=t.sourceControl??this;t.emitEvent!==false&&(this._events.next(new Le(this.value,e)),this._events.next(new de(this.status,e)),this.valueChanges.emit(this.value),this.statusChanges.emit(this.status)),t.onlySelf||this._parent?.updateValueAndValidity(U($({},t),{sourceControl:e}));}_updateTreeValidity(t={emitEvent:true}){this._forEachChild(e=>e._updateTreeValidity(t)),this.updateValueAndValidity({onlySelf:true,emitEvent:t.emitEvent});}_setInitialStatus(){this.status=this._allControlsDisabled()?_e:ge;}_runValidator(){return this.validator?this.validator(this):null}_runAsyncValidator(t,e){if(this.asyncValidator){this.status=le,this._hasOwnPendingAsyncValidator={emitEvent:e!==false,shouldHaveEmitted:t!==false};let i=hn(this.asyncValidator(this));this._asyncValidationSubscription=i.subscribe(r=>{this._hasOwnPendingAsyncValidator=null,this.setErrors(r,{emitEvent:e,shouldHaveEmitted:t});});}}_cancelExistingSubscription(){if(this._asyncValidationSubscription){this._asyncValidationSubscription.unsubscribe();let t=(this._hasOwnPendingAsyncValidator?.emitEvent||this._hasOwnPendingAsyncValidator?.shouldHaveEmitted)??false;return this._hasOwnPendingAsyncValidator=null,t}return  false}setErrors(t,e={}){this.errors=t,this._updateControlsErrors(e.emitEvent!==false,this,e.shouldHaveEmitted);}get(t){let e=t;return e==null||(Array.isArray(e)||(e=e.split(".")),e.length===0)?null:e.reduce((i,r)=>i&&i._find(r),this)}getError(t,e){let i=e?this.get(e):this;return i?.errors?i.errors[t]:null}hasError(t,e){return !!this.getError(t,e)}get root(){let t=this;for(;t._parent;)t=t._parent;return t}_updateControlsErrors(t,e,i){this.status=this._calculateStatus(),t&&this.statusChanges.emit(this.status),(t||i)&&this._events.next(new de(this.status,e)),this._parent&&this._parent._updateControlsErrors(t,e,i);}_initObservables(){this.valueChanges=new Le$1,this.statusChanges=new Le$1;}_calculateStatus(){return this._allControlsDisabled()?_e:this.errors?ke:this._hasOwnPendingAsyncValidator||this._anyControlsHaveStatus(le)?le:this._anyControlsHaveStatus(ke)?ke:ge}_anyControlsHaveStatus(t){return this._anyControls(e=>e.status===t)}_anyControlsDirty(){return this._anyControls(t=>t.dirty)}_anyControlsTouched(){return this._anyControls(t=>t.touched)}_updatePristine(t,e){let i=!this._anyControlsDirty(),r=this.pristine!==i;this.pristine=i,t.onlySelf||this._parent?._updatePristine(t,e),r&&this._events.next(new be(this.pristine,e));}_updateTouched(t={},e){this.touched=this._anyControlsTouched(),this._events.next(new ye(this.touched,e)),t.onlySelf||this._parent?._updateTouched(t,e);}_onDisabledChange=[];_registerOnCollectionChange(t){this._onCollectionChange=t;}_setUpdateStrategy(t){$e(t)&&t.updateOn!=null&&(this._updateOn=t.updateOn);}_parentMarkedDirty(t){return !t&&!!this._parent?.dirty&&!this._parent._anyControlsDirty()}_find(t){return null}_assignValidators(t){this._rawValidators=Array.isArray(t)?t.slice():t,this._composedValidatorFn=mi(this._rawValidators),this._updateHasRequiredValidator();}_assignAsyncValidators(t){this._rawAsyncValidators=Array.isArray(t)?t.slice():t,this._composedAsyncValidatorFn=fi(this._rawAsyncValidators);}_updateHasRequiredValidator(){oD(()=>this._hasRequired.set(this.hasValidator(xe.required)));}};function wn(n,t){return Object.hasOwn(n,t)}function gi(n){return n.tagName==="INPUT"||n.tagName==="SELECT"||n.tagName==="TEXTAREA"}function _i(n,t,e,i){switch(e){case "name":n.setAttribute(t,e,i);break;case "disabled":case "readonly":case "required":i?n.setAttribute(t,e,""):n.removeAttribute(t,e);break;case "max":case "min":case "minLength":case "maxLength":i!==void 0?n.setAttribute(t,e,i.toString()):n.removeAttribute(t,e);break}}var at=class{kind;context;control;message;constructor({kind:t,context:e,control:i}){this.kind=t,this.context=e,this.control=i;}};var vi=(()=>{class n{_validator=Oe;_onChange;_enabled;ngOnChanges(e){if(this.inputName in e){let i=this.normalizeInput(e[this.inputName].currentValue);this._enabled=this.enabled(i),this._validator=this._enabled?this.createValidator(i):Oe,this._onChange?.();}}validate(e){return this._validator(e)}registerOnValidatorChange(e){this._onChange=e;}enabled(e){return e!=null}static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,features:[Ug]})}return n})();var bi={provide:Ue,useExisting:io(()=>Mn),multi:true};var Mn=(()=>{class n extends vi{required;inputName="required";normalizeInput=UP;createValidator=e=>mn;enabled(e){return e}static \u0275fac=(()=>{let e;return function(r){return (e||(e=am(n)))(r||n)}})();static \u0275dir=TI({type:n,selectors:[["","required","","formControlName","",3,"type","checkbox"],["","required","","formControl","",3,"type","checkbox"],["","required","","ngModel","",3,"type","checkbox"]],hostVars:1,hostBindings:function(i,r){i&2&&Yf("required",r._enabled?"":null);},inputs:{required:"required"},standalone:false,features:[GE([bi]),Uf]})}return n})();var yi=new x(""),qe=new x("",{factory:()=>ft}),ft="always";function xi(n,t){return [...t.path,n]}function rn(n,t,e=ft){ht(n,t),t.valueAccessor.writeValue(n.value),(n.disabled||e==="always")&&t.valueAccessor.setDisabledState?.(n.disabled),Di(n,t),Mi(n,t),wi(n,t),Ci(n,t);}function on(n,t,e=true){let i=()=>{};t?.valueAccessor?.registerOnChange(i),t?.valueAccessor?.registerOnTouched(i),He(n,t),n&&(t._invokeOnDestroyCallbacks(),n._registerOnCollectionChange(()=>{}));}function ze(n,t){n.forEach(e=>{e.registerOnValidatorChange&&e.registerOnValidatorChange(t);});}function Ci(n,t){if(t.valueAccessor.setDisabledState){let e=i=>{t.valueAccessor.setDisabledState(i);};n.registerOnDisabledChange(e),t._registerOnDestroy(()=>{n._unregisterOnDisabledChange(e);});}}function ht(n,t){let e=yn(n);t.validator!==null?n.setValidators(en(e,t.validator)):typeof e=="function"&&n.setValidators([e]);let i=xn(n);t.asyncValidator!==null?n.setAsyncValidators(en(i,t.asyncValidator)):typeof i=="function"&&n.setAsyncValidators([i]);let r=()=>n.updateValueAndValidity();ze(t._rawValidators,r),ze(t._rawAsyncValidators,r);}function He(n,t){let e=false;if(n!==null){if(t.validator!==null){let r=yn(n);if(Array.isArray(r)&&r.length>0){let o=r.filter(a=>a!==t.validator);o.length!==r.length&&(e=true,n.setValidators(o));}}if(t.asyncValidator!==null){let r=xn(n);if(Array.isArray(r)&&r.length>0){let o=r.filter(a=>a!==t.asyncValidator);o.length!==r.length&&(e=true,n.setAsyncValidators(o));}}}let i=()=>{};return ze(t._rawValidators,i),ze(t._rawAsyncValidators,i),e}function Di(n,t){t.valueAccessor.registerOnChange(e=>{n._pendingValue=e,n._pendingChange=true,n._pendingDirty=true,n.updateOn==="change"&&Fn(n,t);});}function wi(n,t){t.valueAccessor.registerOnTouched(()=>{n._pendingTouched=true,n.updateOn==="blur"&&n._pendingChange&&Fn(n,t),n.updateOn!=="submit"&&n.markAsTouched();});}function Fn(n,t){n._pendingDirty&&n.markAsDirty(),n.setValue(n._pendingValue,{emitModelToViewChange:false}),t.viewToModelUpdate(n._pendingValue),n._pendingChange=false;}function Mi(n,t){let e=(i,r)=>{t.valueAccessor.writeValue(i),r&&t.viewToModelUpdate(i);};n.registerOnChange(e),t._registerOnDestroy(()=>{n._unregisterOnChange(e);});}function An(n,t){ht(n,t);}function Fi(n,t){return He(n,t)}function Ai(n,t){if(!n.hasOwnProperty("model"))return  false;let e=n.model;return e.isFirstChange()?true:!Object.is(t,e.currentValue)}function Ei(n){return Object.getPrototypeOf(n.constructor)===Jn}function En(n,t){n._syncPendingControls(),t.forEach(e=>{let i=e.control;i.updateOn==="submit"&&i._pendingChange&&(e.viewToModelUpdate(i._pendingValue),i._pendingChange=false);});}function Vi(n,t){if(!t)return null;let e,i,r;return t.forEach(o=>{o.constructor===un?e=o:Ei(o)?i=o:r=o;}),r||i||e||null}function Si(n,t){let e=n.indexOf(t);e>-1&&n.splice(e,1);}var Ii={provide:yi,useFactory:()=>{let n=w(W,{self:true});return {setParseErrors:t=>{n.setParseErrorSource(t);},set onReset(t){n.onReset=t;}}}},W=class extends Pe{_parent=null;name=null;valueAccessor=null;isCustomControlBased=false;userOnReset;resetSubscription;set onReset(t){this.userOnReset=t,this.resetSubscription?.unsubscribe(),this.resetSubscription=void 0,this.control&&(this.resetSubscription=this.control.events.subscribe(e=>{e instanceof ce&&this.control&&this.userOnReset?.(this.control.value);}),this.subscription?.add(this.resetSubscription));}isNativeFormElement=false;rawValueAccessors;_selectedValueAccessor=null;get selectedValueAccessor(){return this._selectedValueAccessor??=Vi(this,this.rawValueAccessors)}parseErrorsValidator=null;renderer;injector;requiredValidatorViaDi;subscription;customControlBindings=null;constructor(t,e,i){super(),this.injector=t,this.renderer=e,this.rawValueAccessors=i,this.injector?.get($e$1)?.onDestroy(()=>{this.removeParseErrorsValidator(this.control),this.subscription?.unsubscribe();});}setupCustomControl(){this.subscription?.unsubscribe();let t=this.injector?.get(BP);if(!this.control||!t)return;let e=t.markForCheck.bind(t);this.subscription=new q$1,this.subscription.add(this.control.valueChanges.subscribe(e)),this.subscription.add(this.control.statusChanges.subscribe(e)),this.resetSubscription?.unsubscribe(),this.resetSubscription=void 0,this.userOnReset&&(this.resetSubscription=this.control.events.subscribe(i=>{i instanceof ce&&this.control&&this.userOnReset?.(this.control.value);}),this.subscription.add(this.resetSubscription)),this.parseErrorsValidator&&this.control.addValidators(this.parseErrorsValidator);}ngControlCreate(t){!t.nativeElement.hasAttribute?.("ngNoCva")&&(this.rawValueAccessors&&this.rawValueAccessors.length>0||this.valueAccessor!==null)||!t.customControl||(this.isCustomControlBased=true,t.listenToCustomControlModel(r=>{this.control?.setValue(r,{emitModelToViewChange:false}),this.control?.markAsDirty(),this.viewToModelUpdate(r);}),t.listenToCustomControlOutput("touch",()=>{this.control?.markAsTouched();}),this.customControlBindings={},this.isNativeFormElement=gi(t.nativeElement),this.requiredValidatorViaDi=this._rawValidators.find(r=>r instanceof Mn));}ngControlUpdate(t,e){if(!this.isCustomControlBased)return;let i=this.control,r=this.customControlBindings;Object.is(r.value,i.value)||(r.value=i.value,t.setCustomControlModelInput(i.value)),this.bindControlProperty(t,r,"touched",i.touched),this.bindControlProperty(t,r,"dirty",i.dirty),this.bindControlProperty(t,r,"valid",i.valid),this.bindControlProperty(t,r,"invalid",i.invalid),this.bindControlProperty(t,r,"pending",i.pending),this.bindControlProperty(t,r,"disabled",i.disabled),this.shouldBindRequired&&this.bindControlProperty(t,r,"required",this.isRequired);let o=i.errors;if(r.errors!==o){r.errors=o;let a=this._convertErrors(o);t.setInputOnDirectives("errors",a);}}get isRequired(){return (this.requiredValidatorViaDi?._enabled||this.control?._hasRequired())??false}get shouldBindRequired(){return  true}bindControlProperty(t,e,i,r){if(e[i]===r)return;e[i]=r;let o=t.setInputOnDirectives(i,r);this.isNativeFormElement&&!o&&(i==="disabled"||i==="required")&&this.renderer&&_i(this.renderer,t.nativeElement,i,r);}_convertErrors(t){if(t===null)return [];let e=this.control;return Object.entries(t).map(([i,r])=>new at({context:r,kind:i,control:e}))}setParseErrorSource(t){if(t===void 0)return;let e=null,i=rD(()=>{let r=t();return r.length===0?null:r.reduce((o,a)=>(o[a.kind]=a,o),{})});this.parseErrorsValidator=(()=>e).bind(this),gu(()=>{e=i(),this.control?.updateValueAndValidity({emitEvent:false});},{injector:this.injector});}removeParseErrorsValidator(t){this.parseErrorsValidator&&(t?.removeValidators(this.parseErrorsValidator),t?.updateValueAndValidity({emitEvent:false}));}},st=class{_cd;constructor(t){this._cd=t;}get isTouched(){return this._cd?.control?._touched?.(),!!this._cd?.control?.touched}get isUntouched(){return !!this._cd?.control?.untouched}get isPristine(){return this._cd?.control?._pristine?.(),!!this._cd?.control?.pristine}get isDirty(){return !!this._cd?.control?.dirty}get isValid(){return this._cd?.control?._status?.(),!!this._cd?.control?.valid}get isInvalid(){return !!this._cd?.control?.invalid}get isPending(){return !!this._cd?.control?.pending}get isSubmitted(){return this._cd?._submitted?.(),!!this._cd?.submitted}};var qr=(()=>{class n extends st{constructor(e){super(e);}static \u0275fac=function(i){return new(i||n)(gr$1(W,2))};static \u0275dir=TI({type:n,selectors:[["","formControlName",""],["","ngModel",""],["","formControl",""]],hostVars:14,hostBindings:function(i,r){i&2&&hp("ng-untouched",r.isUntouched)("ng-touched",r.isTouched)("ng-pristine",r.isPristine)("ng-dirty",r.isDirty)("ng-valid",r.isValid)("ng-invalid",r.isInvalid)("ng-pending",r.isPending);},standalone:false,features:[Uf]})}return n})();var Ge=class extends je{constructor(t,e,i){super(Cn(e),Dn(i,e)),this.controls=t,this._initObservables(),this._setUpdateStrategy(e),this._setUpControls(),this.updateValueAndValidity({onlySelf:true,emitEvent:!!this.asyncValidator});}controls;registerControl(t,e){let i=this._find(t);return i||(this.controls[t]=e,e.setParent(this),e._registerOnCollectionChange(this._onCollectionChange),e)}addControl(t,e,i={}){this.registerControl(t,e),this.updateValueAndValidity({emitEvent:i.emitEvent}),this._onCollectionChange();}removeControl(t,e={}){let i=this._find(t);i&&i._registerOnCollectionChange(()=>{}),delete this.controls[t],this.updateValueAndValidity({emitEvent:e.emitEvent}),this._onCollectionChange();}setControl(t,e,i={}){let r=this._find(t);r&&r._registerOnCollectionChange(()=>{}),delete this.controls[t],e&&this.registerControl(t,e),this.updateValueAndValidity({emitEvent:i.emitEvent}),this._onCollectionChange();}contains(t){return this._find(t)?.enabled===true}setValue(t,e={}){oD(()=>{pi(this,true,t),Object.keys(t).forEach(i=>{hi(this,true,i),this.controls[i].setValue(t[i],{onlySelf:true,emitEvent:e.emitEvent});}),this.updateValueAndValidity(e);});}patchValue(t,e={}){t!=null&&(Object.keys(t).forEach(i=>{let r=this._find(i);r&&r.patchValue(t[i],{onlySelf:true,emitEvent:e.emitEvent});}),this.updateValueAndValidity(e));}reset(t={},e={}){this._forEachChild((i,r)=>{i.reset(t?t[r]:null,U($({},e),{onlySelf:true}));}),this._updatePristine(e,this),this._updateTouched(e,this),this.updateValueAndValidity(e),e?.emitEvent!==false&&this._events.next(new ce(this));}getRawValue(){return this._reduceChildren({},(t,e,i)=>(t[i]=e.getRawValue(),t))}_syncPendingControls(){let t=this._reduceChildren(false,(e,i)=>i._syncPendingControls()?true:e);return t&&this.updateValueAndValidity({onlySelf:true}),t}_forEachChild(t){Object.keys(this.controls).forEach(e=>{let i=this.controls[e];i&&t(i,e);});}_setUpControls(){this._forEachChild(t=>{t.setParent(this),t._registerOnCollectionChange(this._onCollectionChange);});}_updateValue(){this.value=this._reduceValue();}_anyControls(t){for(let[e,i]of Object.entries(this.controls))if(this.contains(e)&&t(i))return  true;return  false}_reduceValue(){let t={};return this._reduceChildren(t,(e,i,r)=>((i.enabled||this.disabled)&&(e[r]=i.value),e))}_reduceChildren(t,e){let i=t;return this._forEachChild((r,o)=>{i=e(i,r,o);}),i}_allControlsDisabled(){for(let t of Object.keys(this.controls))if(this.controls[t].enabled)return  false;return Object.keys(this.controls).length>0||this.disabled}_find(t){return wn(this.controls,t)?this.controls[t]:null}};var Ri={provide:J,useExisting:io(()=>pt)},ve=Promise.resolve(),pt=(()=>{class n extends J{callSetDisabledState;get submitted(){return oD(this.submittedReactive)}_submitted=rD(()=>this.submittedReactive());submittedReactive=_o(false);_directives=new Set;form;ngSubmit=new Le$1;options;constructor(e,i,r){super(),this.callSetDisabledState=r,this.form=new Ge({},ut(e),mt(i));}ngAfterViewInit(){this._setUpdateStrategy();}get formDirective(){return this}get control(){return this.form}get path(){return []}get controls(){return this.form.controls}addControl(e){ve.then(()=>{let i=this._findContainer(e.path);e.control=i.registerControl(e.name,e.control),e._setupWithForm(this.callSetDisabledState),e.control.updateValueAndValidity({emitEvent:false}),this._directives.add(e);});}getControl(e){return this.form.get(e.path)}removeControl(e){ve.then(()=>{this._findContainer(e.path)?.removeControl(e.name),this._directives.delete(e);});}addFormGroup(e){ve.then(()=>{let i=this._findContainer(e.path),r=new Ge({});An(r,e),i.registerControl(e.name,r),r.updateValueAndValidity({emitEvent:false});});}removeFormGroup(e){ve.then(()=>{this._findContainer(e.path)?.removeControl?.(e.name);});}getFormGroup(e){return this.form.get(e.path)}updateModel(e,i){ve.then(()=>{this.form.get(e.path).setValue(i);});}setValue(e){this.control.setValue(e);}onSubmit(e){return this.submittedReactive.set(true),En(this.form,this._directives),this.ngSubmit.emit(e),this.form._events.next(new Be(this.control)),e?.target?.method==="dialog"}onReset(){this.resetForm();}resetForm(e=void 0){this.form.reset(e),this.submittedReactive.set(false);}_setUpdateStrategy(){this.options&&this.options.updateOn!=null&&(this.form._updateOn=this.options.updateOn);}_findContainer(e){return e.pop(),e.length?this.form.get(e):this.form}static \u0275fac=function(i){return new(i||n)(gr$1(Ue,10),gr$1(ct,10),gr$1(qe,8))};static \u0275dir=TI({type:n,selectors:[["form",3,"ngNoForm","",3,"formGroup","",3,"formArray",""],["ng-form"],["","ngForm",""]],hostBindings:function(i,r){i&1&&op("submit",function(a){return r.onSubmit(a)})("reset",function(){return r.onReset()});},inputs:{options:[0,"ngFormOptions","options"]},outputs:{ngSubmit:"ngSubmit"},exportAs:["ngForm"],standalone:false,features:[GE([Ri]),Uf]})}return n})();function an(n,t){let e=n.indexOf(t);e>-1&&n.splice(e,1);}function sn(n){return typeof n=="object"&&n!==null&&Object.keys(n).length===2&&"value"in n&&"disabled"in n}var Vn=class extends je{defaultValue=null;_onChange=[];_pendingValue;_pendingChange=false;constructor(t=null,e,i){super(Cn(e),Dn(i,e)),this._applyFormState(t),this._setUpdateStrategy(e),this._initObservables(),this.updateValueAndValidity({onlySelf:true,emitEvent:!!this.asyncValidator}),$e(e)&&(e.nonNullable||e.initialValueIsDefault)&&(sn(t)?this.defaultValue=t.value:this.defaultValue=t);}setValue(t,e={}){oD(()=>{this.value=this._pendingValue=t,this._onChange.length&&e.emitModelToViewChange!==false&&this._onChange.forEach(i=>i(this.value,e.emitViewToModelChange!==false)),this.updateValueAndValidity(e);});}patchValue(t,e={}){this.setValue(t,e);}reset(t=this.defaultValue,e={}){this._applyFormState(t),this.markAsPristine(e),this.markAsUntouched(e),this.setValue(this.value,e),e.overwriteDefaultValue&&(this.defaultValue=this.value),this._pendingChange=false,e?.emitEvent!==false&&this._events.next(new ce(this));}_updateValue(){}_anyControls(t){return  false}_allControlsDisabled(){return this.disabled}registerOnChange(t){this._onChange.push(t);}_unregisterOnChange(t){an(this._onChange,t);}registerOnDisabledChange(t){this._onDisabledChange.push(t);}_unregisterOnDisabledChange(t){an(this._onDisabledChange,t);}_forEachChild(t){}_syncPendingControls(){return this.updateOn==="submit"&&(this._pendingDirty&&this.markAsDirty(),this._pendingTouched&&this.markAsTouched(),this._pendingChange)?(this.setValue(this._pendingValue,{onlySelf:true,emitModelToViewChange:false}),true):false}_applyFormState(t){sn(t)?(this.value=this._pendingValue=t.value,t.disabled?this.disable({onlySelf:true,emitEvent:false}):this.enable({onlySelf:true,emitEvent:false})):this.value=this._pendingValue=t;}};var Ti=n=>n instanceof Vn;var ki={provide:W,useExisting:io(()=>Oi)},ln=Promise.resolve(),Oi=(()=>{class n extends W{_changeDetectorRef;callSetDisabledState;control=new Vn;static ngAcceptInputType_isDisabled;_registered=false;viewModel;name="";isDisabled;model;options;update=new Le$1;constructor(e,i,r,o,a,l,c,d){super(c,d,o),this._changeDetectorRef=a,this.callSetDisabledState=l,this._parent=e,this._setValidators(i),this._setAsyncValidators(r);}ngOnChanges(e){if(this._checkForErrors(),!this._registered||"name"in e){if(this._registered&&(this._checkName(),this.formDirective)){let i=e.name.previousValue;this.formDirective.removeControl({name:i,path:this._getPath(i)});}this._setUpControl();}"isDisabled"in e&&this._updateDisabled(e),Ai(e,this.viewModel)&&(this._updateValue(this.model),this.viewModel=this.model);}ngOnDestroy(){this.formDirective?.removeControl(this);}\u0275ngControlCreate(e){super.ngControlCreate(e);}\u0275ngControlUpdate(e){super.ngControlUpdate(e,false);}get shouldBindRequired(){return  false}get path(){return this._getPath(this.name)}get formDirective(){return this._parent?this._parent.formDirective:null}viewToModelUpdate(e){this.viewModel=e,this.update.emit(e);}_setUpControl(){this._setUpdateStrategy(),this._isStandalone()?this._setUpStandalone():this.formDirective.addControl(this),this._registered=true;}_setUpdateStrategy(){this.options&&this.options.updateOn!=null&&(this.control._updateOn=this.options.updateOn);}_isStandalone(){return !this._parent||!!(this.options&&this.options.standalone)}_setUpStandalone(){this.isCustomControlBased?this.setupCustomControl():(this.valueAccessor??=this.selectedValueAccessor,rn(this.control,this,this.callSetDisabledState)),this.control.updateValueAndValidity({emitEvent:false});}_setupWithForm(e){this.isCustomControlBased?this.setupCustomControl():(this.valueAccessor??=this.selectedValueAccessor,rn(this.control,this,e));}_checkForErrors(){this._checkName();}_checkName(){this.options&&this.options.name&&(this.name=this.options.name),!this._isStandalone()&&this.name;}_updateValue(e){ln.then(()=>{this.control.setValue(e,{emitViewToModelChange:false}),this._changeDetectorRef?.markForCheck();});}_updateDisabled(e){let i=e.isDisabled.currentValue,r=i!==0&&UP(i);ln.then(()=>{r&&!this.control.disabled?this.control.disable():!r&&this.control.disabled&&this.control.enable(),this._changeDetectorRef?.markForCheck();});}_getPath(e){return this._parent?xi(e,this._parent):[e]}static \u0275fac=function(i){return new(i||n)(gr$1(J,9),gr$1(Ue,10),gr$1(ct,10),gr$1(cn,10),gr$1(BP,8),gr$1(qe,8),gr$1(he,8),gr$1(Cv,8))};static \u0275dir=TI({type:n,selectors:[["","ngModel","",3,"formControlName","",3,"formControl",""]],inputs:{name:"name",isDisabled:[0,"disabled","isDisabled"],model:[0,"ngModel","model"],options:[0,"ngModelOptions","options"]},outputs:{update:"ngModelChange"},exportAs:["ngModel"],standalone:false,features:[GE([ki,Ii]),Uf,Ug,_I(null)]})}return n})();var Ni=(()=>{class n extends J{callSetDisabledState;get submitted(){return oD(this._submittedReactive)}set submitted(e){this._submittedReactive.set(e);}_submitted=rD(()=>this._submittedReactive());_submittedReactive=_o(false);_oldForm;_onCollectionChange=()=>this._updateDomValue();directives=[];constructor(e,i,r){super(),this.callSetDisabledState=r,this._setValidators(e),this._setAsyncValidators(i);}ngOnChanges(e){this.onChanges(e);}ngOnDestroy(){this.onDestroy();}onChanges(e){this._checkFormPresent(),e.hasOwnProperty("form")&&(this._updateValidators(),this._updateDomValue(),this._updateRegistrations(),this._oldForm=this.form);}onDestroy(){this.form&&(He(this.form,this),this.form._onCollectionChange===this._onCollectionChange&&this.form._registerOnCollectionChange(()=>{}));}get formDirective(){return this}get path(){return []}addControl(e){let i=this.form.get(e.path);return e._setupWithForm(i,this.callSetDisabledState),i.updateValueAndValidity({emitEvent:false}),this.directives.push(e),i}getControl(e){return this.form.get(e.path)}removeControl(e){on(e.control||null,e,false),Si(this.directives,e);}addFormGroup(e){this._setUpFormContainer(e);}removeFormGroup(e){this._cleanUpFormContainer(e);}getFormGroup(e){return this.form.get(e.path)}getFormArray(e){return this.form.get(e.path)}addFormArray(e){this._setUpFormContainer(e);}removeFormArray(e){this._cleanUpFormContainer(e);}updateModel(e,i){this.form.get(e.path).setValue(i);}onReset(){this.resetForm();}resetForm(e=void 0,i={}){this.form.reset(e,i),this._submittedReactive.set(false);}onSubmit(e){return this.submitted=true,En(this.form,this.directives),this.ngSubmit.emit(e),this.form._events.next(new Be(this.control)),e?.target?.method==="dialog"}_updateDomValue(){this.directives.forEach(e=>{let i=e.control,r=this.form.get(e.path);i!==r&&(on(i||null,e),Ti(r)&&e._setupWithForm(r,this.callSetDisabledState));}),this.form._updateTreeValidity({emitEvent:false});}_setUpFormContainer(e){let i=this.form.get(e.path);An(i,e),i.updateValueAndValidity({emitEvent:false});}_cleanUpFormContainer(e){let i=this.form?.get(e.path);i&&Fi(i,e)&&i.updateValueAndValidity({emitEvent:false});}_updateRegistrations(){this.form._registerOnCollectionChange(this._onCollectionChange),this._oldForm?._registerOnCollectionChange(()=>{});}_updateValidators(){ht(this.form,this),this._oldForm&&He(this._oldForm,this);}_checkFormPresent(){this.form;}static \u0275fac=function(i){return new(i||n)(gr$1(Ue,10),gr$1(ct,10),gr$1(qe,8))};static \u0275dir=TI({type:n,features:[Uf,Ug]})}return n})();var Pi={provide:J,useExisting:io(()=>gt)},gt=(()=>{class n extends Ni{form=null;ngSubmit=new Le$1;get control(){return this.form}static \u0275fac=(()=>{let e;return function(r){return (e||(e=am(n)))(r||n)}})();static \u0275dir=TI({type:n,selectors:[["","formGroup",""]],hostBindings:function(i,r){i&1&&op("submit",function(a){return r.onSubmit(a)})("reset",function(){return r.onReset()});},inputs:{form:[0,"formGroup","form"]},outputs:{ngSubmit:"ngSubmit"},exportAs:["ngForm"],standalone:false,features:[GE([Pi]),Uf]})}return n})();var Li=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({})}return n})();var Qr=(()=>{class n{static withConfig(e){return {ngModule:n,providers:[{provide:qe,useValue:e.callSetDisabledState??ft}]}}static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({imports:[Li]})}return n})();var _t=class{_box;_destroyed=new ee$1;_resizeSubject=new ee$1;_resizeObserver;_elementObservables=new Map;constructor(t){this._box=t,typeof ResizeObserver<"u"&&(this._resizeObserver=new ResizeObserver(e=>this._resizeSubject.next(e)));}observe(t){return this._elementObservables.has(t)||this._elementObservables.set(t,new M$1(e=>{let i=this._resizeSubject.subscribe(e);return this._resizeObserver?.observe(t,{box:this._box}),()=>{this._resizeObserver?.unobserve(t),i.unsubscribe(),this._elementObservables.delete(t);}}).pipe(Sn$1(e=>e.some(i=>i.target===t)),jh({bufferSize:1,refCount:true}),$h(this._destroyed))),this._elementObservables.get(t)}destroy(){this._destroyed.next(),this._destroyed.complete(),this._resizeSubject.complete(),this._elementObservables.clear();}},Sn=(()=>{class n{_cleanupErrorListener;_observers=new Map;_ngZone=w(Ce);constructor(){}ngOnDestroy(){for(let[,e]of this._observers)e.destroy();this._observers.clear(),this._cleanupErrorListener?.();}observe(e,i){let r=i?.box||"content-box";return this._observers.has(r)||this._observers.set(r,new _t(r)),this._observers.get(r).observe(e)}static \u0275fac=function(i){return new(i||n)};static \u0275prov=cr$1({token:n,factory:n.\u0275fac})}return n})();var Bi=["notch"],ji=["*"],In=["iconPrefixContainer"],Rn=["textPrefixContainer"],Tn=["iconSuffixContainer"],kn=["textSuffixContainer"],zi=["textField"],Hi=["*",[["mat-label"]],[["","matPrefix",""],["","matIconPrefix",""]],[["","matTextPrefix",""]],[["","matTextSuffix",""]],[["","matSuffix",""],["","matIconSuffix",""]],[["mat-error"],["","matError",""]],[["mat-hint",3,"align","end"]],[["mat-hint","align","end"]]],Gi=["*","mat-label","[matPrefix], [matIconPrefix]","[matTextPrefix]","[matTextSuffix]","[matSuffix], [matIconSuffix]","mat-error, [matError]","mat-hint:not([align='end'])","mat-hint[align='end']"];function Ui(n,t){n&1&&Jf(0,"span",21);}function $i(n,t){if(n&1&&(oi$1(0,"label",20),aE(1,1),HI(2,Ui,1,0,"span",21),yc()),n&2){let e=oE(2);Kf("floating",e._shouldLabelFloat())("monitorResize",e._hasOutline())("id",e._labelId),Yf("for",e._control.disableAutomaticLabeling?null:e._control.id),Hy(2),BI(!e.hideRequiredMarker&&e._control.required?2:-1);}}function qi(n,t){if(n&1&&HI(0,$i,3,5,"label",20),n&2){let e=oE();BI(e._hasFloatingLabel()?0:-1);}}function Wi(n,t){n&1&&Jf(0,"div",7);}function Qi(n,t){}function Zi(n,t){if(n&1&&qf(0,Qi,0,0,"ng-template",13),n&2){oE(2);let e=fE(1);Kf("ngTemplateOutlet",e);}}function Xi(n,t){if(n&1&&(oi$1(0,"div",9),HI(1,Zi,1,1,null,13),yc()),n&2){let e=oE();Kf("matFormFieldNotchedOutlineOpen",e._shouldLabelFloat()),Hy(),BI(e._forceDisplayInfixLabel()?-1:1);}}function Yi(n,t){n&1&&(oi$1(0,"div",10,2),aE(2,2),yc());}function Ki(n,t){n&1&&(oi$1(0,"div",11,3),aE(2,3),yc());}function Ji(n,t){}function er(n,t){if(n&1&&qf(0,Ji,0,0,"ng-template",13),n&2){oE();let e=fE(1);Kf("ngTemplateOutlet",e);}}function tr(n,t){n&1&&(oi$1(0,"div",14,4),aE(2,4),yc());}function nr(n,t){n&1&&(oi$1(0,"div",15,5),aE(2,5),yc());}function ir(n,t){n&1&&Jf(0,"div",16);}function rr(n,t){n&1&&(oi$1(0,"div",18),aE(1,6),yc());}function or(n,t){if(n&1&&(oi$1(0,"mat-hint",22),OE(1),yc()),n&2){let e=oE(2);Kf("id",e._hintLabelId),Hy(),Ep(e.hintLabel);}}function ar(n,t){if(n&1&&(oi$1(0,"div",19),HI(1,or,2,2,"mat-hint",22),aE(2,7),Jf(3,"div",23),aE(4,8),yc()),n&2){let e=oE();Hy(),BI(e.hintLabel?1:-1);}}var vt=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,selectors:[["mat-label"]]})}return n})(),sr=new x("MatError");var bt=(()=>{class n{align="start";id=w(yt$1).getId("mat-mdc-hint-");static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,selectors:[["mat-hint"]],hostAttrs:[1,"mat-mdc-form-field-hint","mat-mdc-form-field-bottom-align"],hostVars:4,hostBindings:function(i,r){i&2&&(np("id",r.id),Yf("align",null),hp("mat-mdc-form-field-hint-end",r.align==="end"));},inputs:{align:"align",id:"id"}})}return n})(),lr=new x("MatPrefix");var dr=new x("MatSuffix");var zn=new x("FloatingLabelParent"),On=(()=>{class n{_elementRef=w(lr$1);get floating(){return this._floating}set floating(e){this._floating=e,this.monitorResize&&this._handleResize();}_floating=false;get monitorResize(){return this._monitorResize}set monitorResize(e){this._monitorResize=e,this._monitorResize?this._subscribeToResize():this._resizeSubscription.unsubscribe();}_monitorResize=false;_resizeObserver=w(Sn);_ngZone=w(Ce);_parent=w(zn);_resizeSubscription=new q$1;ngOnDestroy(){this._resizeSubscription.unsubscribe();}getWidth(){return cr(this._elementRef.nativeElement)}get element(){return this._elementRef.nativeElement}_handleResize(){setTimeout(()=>this._parent._handleLabelResized());}_subscribeToResize(){this._resizeSubscription.unsubscribe(),this._ngZone.runOutsideAngular(()=>{this._resizeSubscription=this._resizeObserver.observe(this._elementRef.nativeElement,{box:"border-box"}).subscribe(()=>this._handleResize());});}static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,selectors:[["label","matFormFieldFloatingLabel",""]],hostAttrs:[1,"mdc-floating-label","mat-mdc-floating-label"],hostVars:2,hostBindings:function(i,r){i&2&&hp("mdc-floating-label--float-above",r.floating);},inputs:{floating:"floating",monitorResize:"monitorResize"}})}return n})();function cr(n){let t=n;if(t.offsetParent!==null)return t.scrollWidth;let e=t.cloneNode(true);e.style.setProperty("position","absolute"),e.style.setProperty("transform","translate(-9999px, -9999px)"),document.documentElement.appendChild(e);let i=e.scrollWidth;return e.remove(),i}var Nn="mdc-line-ripple--active",We="mdc-line-ripple--deactivating",Pn=(()=>{class n{_elementRef=w(lr$1);_cleanupTransitionEnd;constructor(){let e=w(Ce),i=w(Cv);e.runOutsideAngular(()=>{this._cleanupTransitionEnd=i.listen(this._elementRef.nativeElement,"transitionend",this._handleTransitionEnd);});}activate(){let e=this._elementRef.nativeElement.classList;e.remove(We),e.add(Nn);}deactivate(){this._elementRef.nativeElement.classList.add(We);}_handleTransitionEnd=e=>{let i=this._elementRef.nativeElement.classList,r=i.contains(We);e.propertyName==="opacity"&&r&&i.remove(Nn,We);};ngOnDestroy(){this._cleanupTransitionEnd();}static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,selectors:[["div","matFormFieldLineRipple",""]],hostAttrs:[1,"mdc-line-ripple"]})}return n})(),Ln=(()=>{class n{_elementRef=w(lr$1);_ngZone=w(Ce);open=false;_notch;ngAfterViewInit(){let e=this._elementRef.nativeElement,i=e.querySelector(".mdc-floating-label");i?(e.classList.add("mdc-notched-outline--upgraded"),typeof requestAnimationFrame=="function"&&(i.style.transitionDuration="0s",this._ngZone.runOutsideAngular(()=>{requestAnimationFrame(()=>i.style.transitionDuration="");}))):e.classList.add("mdc-notched-outline--no-label");}_setNotchWidth(e){let i=this._notch.nativeElement;!this.open||!e?i.style.width="":i.style.width=`calc(${e}px * var(--mat-mdc-form-field-floating-label-scale, 0.75) + 9px)`;}_setMaxWidth(e){this._notch.nativeElement.style.setProperty("--mat-form-field-notch-max-width",`calc(100% - ${e}px)`);}static \u0275fac=function(i){return new(i||n)};static \u0275cmp=vI({type:n,selectors:[["div","matFormFieldNotchedOutline",""]],viewQuery:function(i,r){if(i&1&&cp(Bi,5),i&2){let o;lE(o=uE())&&(r._notch=o.first);}},hostAttrs:[1,"mdc-notched-outline"],hostVars:2,hostBindings:function(i,r){i&2&&hp("mdc-notched-outline--notched",r.open);},inputs:{open:[0,"matFormFieldNotchedOutlineOpen","open"]},ngContentSelectors:ji,decls:5,vars:0,consts:[["notch",""],[1,"mat-mdc-notch-piece","mdc-notched-outline__leading"],[1,"mat-mdc-notch-piece","mdc-notched-outline__notch"],[1,"mat-mdc-notch-piece","mdc-notched-outline__trailing"]],template:function(i,r){i&1&&(sE(),Xf(0,"div",1),vc(1,"div",2,0),aE(3),Ic(),Xf(4,"div",3));},encapsulation:2})}return n})(),yt=(()=>{class n{value=null;stateChanges;id;placeholder;ngControl=null;focused=false;empty=false;shouldLabelFloat=false;required=false;disabled=false;errorState=false;controlType;autofilled;userAriaDescribedBy;disableAutomaticLabeling;describedByIds;static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n})}return n})();var xt=new x("MatFormField"),ur=new x("MAT_FORM_FIELD_DEFAULT_OPTIONS"),Bn="fill",mr="auto",jn="fixed",fr="translateY(-50%)",Hn=(()=>{class n{_elementRef=w(lr$1);_changeDetectorRef=w(BP);_platform=w(An$1);_idGenerator=w(yt$1);_ngZone=w(Ce);_defaults=w(ur,{optional:true});_currentDirection;_textField;_iconPrefixContainer;_textPrefixContainer;_iconSuffixContainer;_textSuffixContainer;_floatingLabel;_notchedOutline;_lineRipple;_iconPrefixContainerSignal=jP("iconPrefixContainer");_textPrefixContainerSignal=jP("textPrefixContainer");_iconSuffixContainerSignal=jP("iconSuffixContainer");_textSuffixContainerSignal=jP("textSuffixContainer");_prefixSuffixContainers=rD(()=>[this._iconPrefixContainerSignal(),this._textPrefixContainerSignal(),this._iconSuffixContainerSignal(),this._textSuffixContainerSignal()].map(e=>e?.nativeElement).filter(e=>e!==void 0));_formFieldControl;_prefixChildren;_suffixChildren;_errorChildren;_hintChildren;_labelChild=VP(vt);get hideRequiredMarker(){return this._hideRequiredMarker}set hideRequiredMarker(e){this._hideRequiredMarker=fs(e);}_hideRequiredMarker=false;color="primary";get floatLabel(){return this._floatLabel||this._defaults?.floatLabel||mr}set floatLabel(e){e!==this._floatLabel&&(this._floatLabel=e,this._changeDetectorRef.markForCheck());}_floatLabel;get appearance(){return this._appearanceSignal()}set appearance(e){let i=e||this._defaults?.appearance||Bn;this._appearanceSignal.set(i);}_appearanceSignal=_o(Bn);get subscriptSizing(){return this._subscriptSizing||this._defaults?.subscriptSizing||jn}set subscriptSizing(e){this._subscriptSizing=e||this._defaults?.subscriptSizing||jn;}_subscriptSizing=null;get hintLabel(){return this._hintLabel}set hintLabel(e){this._hintLabel=e,this._processHints();}_hintLabel="";_hasIconPrefix=false;_hasTextPrefix=false;_hasIconSuffix=false;_hasTextSuffix=false;_labelId=this._idGenerator.getId("mat-mdc-form-field-label-");_hintLabelId=this._idGenerator.getId("mat-mdc-hint-");_describedByIds;get _control(){return this._explicitFormFieldControl||this._formFieldControl}set _control(e){this._explicitFormFieldControl=e;}_destroyed=new ee$1;_isFocused=null;_explicitFormFieldControl;_previousControl=null;_previousControlValidatorFn=null;_stateChanges;_valueChanges;_describedByChanges;_outlineLabelOffsetResizeObserver=null;_animationsDisabled=nu();constructor(){let e=this._defaults,i=w(Hr);e&&(e.appearance&&(this.appearance=e.appearance),this._hideRequiredMarker=!!e?.hideRequiredMarker,e.color&&(this.color=e.color)),gu(()=>this._currentDirection=i.valueSignal()),this._syncOutlineLabelOffset();}ngAfterViewInit(){this._updateFocusState(),this._animationsDisabled||this._ngZone.runOutsideAngular(()=>{setTimeout(()=>{this._elementRef.nativeElement.classList.add("mat-form-field-animations-enabled");},300);}),this._changeDetectorRef.detectChanges();}ngAfterContentInit(){this._assertFormFieldControl(),this._initializeSubscript(),this._initializePrefixAndSuffix();}ngAfterContentChecked(){this._assertFormFieldControl(),this._control!==this._previousControl&&(this._initializeControl(this._previousControl),this._control.ngControl&&this._control.ngControl.control&&(this._previousControlValidatorFn=this._control.ngControl.control.validator),this._previousControl=this._control),this._control.ngControl&&this._control.ngControl.control&&this._control.ngControl.control.validator!==this._previousControlValidatorFn&&this._changeDetectorRef.markForCheck();}ngOnDestroy(){this._outlineLabelOffsetResizeObserver?.disconnect(),this._stateChanges?.unsubscribe(),this._valueChanges?.unsubscribe(),this._describedByChanges?.unsubscribe(),this._destroyed.next(),this._destroyed.complete();}getLabelId=rD(()=>this._hasFloatingLabel()?this._labelId:null);getConnectedOverlayOrigin(){return this._textField||this._elementRef}_animateAndLockLabel(){this._hasFloatingLabel()&&(this.floatLabel="always");}_initializeControl(e){let i=this._control,r="mat-mdc-form-field-type-";e&&this._elementRef.nativeElement.classList.remove(r+e.controlType),i.controlType&&this._elementRef.nativeElement.classList.add(r+i.controlType),this._stateChanges?.unsubscribe(),this._stateChanges=i.stateChanges.subscribe(()=>{this._updateFocusState(),this._changeDetectorRef.markForCheck();}),this._describedByChanges?.unsubscribe(),this._describedByChanges=i.stateChanges.pipe(Hh([void 0,void 0]),mt$1(()=>[i.errorState,i.userAriaDescribedBy]),Fh(),Sn$1(([[o,a],[l,c]])=>o!==l||a!==c)).subscribe(()=>this._syncDescribedByIds()),this._valueChanges?.unsubscribe(),i.ngControl&&i.ngControl.valueChanges&&(this._valueChanges=i.ngControl.valueChanges.pipe($h(this._destroyed)).subscribe(()=>this._changeDetectorRef.markForCheck()));}_checkPrefixAndSuffixTypes(){this._hasIconPrefix=!!this._prefixChildren.find(e=>!e._isText),this._hasTextPrefix=!!this._prefixChildren.find(e=>e._isText),this._hasIconSuffix=!!this._suffixChildren.find(e=>!e._isText),this._hasTextSuffix=!!this._suffixChildren.find(e=>e._isText);}_initializePrefixAndSuffix(){this._checkPrefixAndSuffixTypes(),Mh(this._prefixChildren.changes,this._suffixChildren.changes).subscribe(()=>{this._checkPrefixAndSuffixTypes(),this._changeDetectorRef.markForCheck();});}_initializeSubscript(){this._hintChildren.changes.subscribe(()=>{this._processHints(),this._changeDetectorRef.markForCheck();}),this._errorChildren.changes.subscribe(()=>{this._syncDescribedByIds(),this._changeDetectorRef.markForCheck();}),this._validateHints(),this._syncDescribedByIds();}_assertFormFieldControl(){this._control;}_updateFocusState(){let e=this._control.focused;e&&!this._isFocused?(this._isFocused=true,this._lineRipple?.activate()):!e&&(this._isFocused||this._isFocused===null)&&(this._isFocused=false,this._lineRipple?.deactivate()),this._elementRef.nativeElement.classList.toggle("mat-focused",e),this._textField?.nativeElement.classList.toggle("mdc-text-field--focused",e);}_syncOutlineLabelOffset(){qP({earlyRead:()=>{if(this._appearanceSignal()!=="outline")return this._outlineLabelOffsetResizeObserver?.disconnect(),null;if(globalThis.ResizeObserver){this._outlineLabelOffsetResizeObserver||=new globalThis.ResizeObserver(()=>{this._writeOutlinedLabelStyles(this._getOutlinedLabelOffset());});for(let e of this._prefixSuffixContainers())this._outlineLabelOffsetResizeObserver.observe(e,{box:"border-box"});}return this._getOutlinedLabelOffset()},write:e=>this._writeOutlinedLabelStyles(e())});}_shouldAlwaysFloat(){return this.floatLabel==="always"}_hasOutline(){return this.appearance==="outline"}_forceDisplayInfixLabel(){return !this._platform.isBrowser&&this._prefixChildren.length&&!this._shouldLabelFloat()}_hasFloatingLabel=rD(()=>!!this._labelChild());_shouldLabelFloat(){return this._hasFloatingLabel()?this._control.shouldLabelFloat||this._shouldAlwaysFloat():false}_shouldForward(e){let i=this._control?this._control.ngControl:null;return i&&i[e]}_getSubscriptMessageType(){return this._errorChildren&&this._errorChildren.length>0&&this._control.errorState?"error":"hint"}_handleLabelResized(){this._refreshOutlineNotchWidth();}_refreshOutlineNotchWidth(){!this._hasOutline()||!this._floatingLabel||!this._shouldLabelFloat()?this._notchedOutline?._setNotchWidth(0):this._notchedOutline?._setNotchWidth(this._floatingLabel.getWidth());}_processHints(){this._validateHints(),this._syncDescribedByIds();}_validateHints(){this._hintChildren;}_syncDescribedByIds(){if(this._control){let e=[];if(this._control.userAriaDescribedBy&&typeof this._control.userAriaDescribedBy=="string"&&e.push(...this._control.userAriaDescribedBy.split(" ")),this._getSubscriptMessageType()==="hint"){let o=this._hintChildren?this._hintChildren.find(l=>l.align==="start"):null,a=this._hintChildren?this._hintChildren.find(l=>l.align==="end"):null;o?e.push(o.id):this._hintLabel&&e.push(this._hintLabelId),a&&e.push(a.id);}else this._errorChildren&&e.push(...this._errorChildren.map(o=>o.id));let i=this._control.describedByIds,r;if(i){let o=this._describedByIds||e;r=e.concat(i.filter(a=>a&&!o.includes(a)));}else r=e;this._control.setDescribedByIds(r),this._describedByIds=e;}}_getOutlinedLabelOffset(){if(!this._hasOutline()||!this._floatingLabel)return null;if(!this._iconPrefixContainer&&!this._textPrefixContainer)return ["",null];if(!this._isAttachedToDom())return null;let e=this._iconPrefixContainer?.nativeElement,i=this._textPrefixContainer?.nativeElement,r=this._iconSuffixContainer?.nativeElement,o=this._textSuffixContainer?.nativeElement,a=e?.getBoundingClientRect().width??0,l=i?.getBoundingClientRect().width??0,c=r?.getBoundingClientRect().width??0,d=o?.getBoundingClientRect().width??0,_=this._currentDirection==="rtl"?"-1":"1",u=`${a+l}px`,G=`calc(${_} * (${u} + var(--mat-mdc-form-field-label-offset-x, 0px)))`,ue=`var(--mat-mdc-form-field-label-transform, ${fr} translateX(${G}))`,Ce=a+l+c+d;return [ue,Ce]}_writeOutlinedLabelStyles(e){if(e!==null){let[i,r]=e;this._floatingLabel&&(this._floatingLabel.element.style.transform=i),r!==null&&this._notchedOutline?._setMaxWidth(r);}}_isAttachedToDom(){let e=this._elementRef.nativeElement;if(e.getRootNode){let i=e.getRootNode();return i&&i!==e}return document.documentElement.contains(e)}static \u0275fac=function(i){return new(i||n)};static \u0275cmp=vI({type:n,selectors:[["mat-form-field"]],contentQueries:function(i,r,o){if(i&1&&(lp(o,r._labelChild,vt,5),ap(o,yt,5)(o,lr,5)(o,dr,5)(o,sr,5)(o,bt,5)),i&2){dE();let a;lE(a=uE())&&(r._formFieldControl=a.first),lE(a=uE())&&(r._prefixChildren=a),lE(a=uE())&&(r._suffixChildren=a),lE(a=uE())&&(r._errorChildren=a),lE(a=uE())&&(r._hintChildren=a);}},viewQuery:function(i,r){if(i&1&&(up(r._iconPrefixContainerSignal,In,5)(r._textPrefixContainerSignal,Rn,5)(r._iconSuffixContainerSignal,Tn,5)(r._textSuffixContainerSignal,kn,5),cp(zi,5)(In,5)(Rn,5)(Tn,5)(kn,5)(On,5)(Ln,5)(Pn,5)),i&2){dE(4);let o;lE(o=uE())&&(r._textField=o.first),lE(o=uE())&&(r._iconPrefixContainer=o.first),lE(o=uE())&&(r._textPrefixContainer=o.first),lE(o=uE())&&(r._iconSuffixContainer=o.first),lE(o=uE())&&(r._textSuffixContainer=o.first),lE(o=uE())&&(r._floatingLabel=o.first),lE(o=uE())&&(r._notchedOutline=o.first),lE(o=uE())&&(r._lineRipple=o.first);}},hostAttrs:[1,"mat-mdc-form-field"],hostVars:38,hostBindings:function(i,r){i&2&&hp("mat-mdc-form-field-label-always-float",r._shouldAlwaysFloat())("mat-mdc-form-field-has-icon-prefix",r._hasIconPrefix)("mat-mdc-form-field-has-icon-suffix",r._hasIconSuffix)("mat-form-field-invalid",r._control.errorState)("mat-form-field-disabled",r._control.disabled)("mat-form-field-autofilled",r._control.autofilled)("mat-form-field-appearance-fill",r.appearance=="fill")("mat-form-field-appearance-outline",r.appearance=="outline")("mat-form-field-hide-placeholder",r._hasFloatingLabel()&&!r._shouldLabelFloat())("mat-primary",r.color!=="accent"&&r.color!=="warn")("mat-accent",r.color==="accent")("mat-warn",r.color==="warn")("ng-untouched",r._shouldForward("untouched"))("ng-touched",r._shouldForward("touched"))("ng-pristine",r._shouldForward("pristine"))("ng-dirty",r._shouldForward("dirty"))("ng-valid",r._shouldForward("valid"))("ng-invalid",r._shouldForward("invalid"))("ng-pending",r._shouldForward("pending"));},inputs:{hideRequiredMarker:"hideRequiredMarker",color:"color",floatLabel:"floatLabel",appearance:"appearance",subscriptSizing:"subscriptSizing",hintLabel:"hintLabel"},exportAs:["matFormField"],features:[GE([{provide:xt,useExisting:n},{provide:zn,useExisting:n}])],ngContentSelectors:Gi,decls:18,vars:21,consts:[["labelTemplate",""],["textField",""],["iconPrefixContainer",""],["textPrefixContainer",""],["textSuffixContainer",""],["iconSuffixContainer",""],[1,"mat-mdc-text-field-wrapper","mdc-text-field",3,"click"],[1,"mat-mdc-form-field-focus-overlay"],[1,"mat-mdc-form-field-flex"],["matFormFieldNotchedOutline","",3,"matFormFieldNotchedOutlineOpen"],[1,"mat-mdc-form-field-icon-prefix"],[1,"mat-mdc-form-field-text-prefix"],[1,"mat-mdc-form-field-infix"],[3,"ngTemplateOutlet"],[1,"mat-mdc-form-field-text-suffix"],[1,"mat-mdc-form-field-icon-suffix"],["matFormFieldLineRipple",""],["aria-atomic","true","aria-live","polite",1,"mat-mdc-form-field-subscript-wrapper","mat-mdc-form-field-bottom-align"],[1,"mat-mdc-form-field-error-wrapper"],[1,"mat-mdc-form-field-hint-wrapper"],["matFormFieldFloatingLabel","",3,"floating","monitorResize","id"],["aria-hidden","true",1,"mat-mdc-form-field-required-marker","mdc-floating-label--required"],[3,"id"],[1,"mat-mdc-form-field-hint-spacer"]],template:function(i,r){if(i&1&&(sE(Hi),qf(0,qi,1,1,"ng-template",null,0,eD),oi$1(2,"div",6,1),op("click",function(a){return r._control.onContainerClick(a)}),HI(4,Wi,1,0,"div",7),oi$1(5,"div",8),HI(6,Xi,2,2,"div",9),HI(7,Yi,3,0,"div",10),HI(8,Ki,3,0,"div",11),oi$1(9,"div",12),HI(10,er,1,1,null,13),aE(11),yc(),HI(12,tr,3,0,"div",14),HI(13,nr,3,0,"div",15),yc(),HI(14,ir,1,0,"div",16),yc(),oi$1(15,"div",17),HI(16,rr,2,0,"div",18)(17,ar,5,1,"div",19),yc()),i&2){let o;Hy(2),hp("mdc-text-field--filled",!r._hasOutline())("mdc-text-field--outlined",r._hasOutline())("mdc-text-field--no-label",!r._hasFloatingLabel())("mdc-text-field--disabled",r._control.disabled)("mdc-text-field--invalid",r._control.errorState),Hy(2),BI(!r._hasOutline()&&!r._control.disabled?4:-1),Hy(2),BI(r._hasOutline()?6:-1),Hy(),BI(r._hasIconPrefix?7:-1),Hy(),BI(r._hasTextPrefix?8:-1),Hy(2),BI(!r._hasOutline()||r._forceDisplayInfixLabel()?10:-1),Hy(2),BI(r._hasTextSuffix?12:-1),Hy(),BI(r._hasIconSuffix?13:-1),Hy(),BI(r._hasOutline()?-1:14),Hy(),hp("mat-mdc-form-field-subscript-dynamic-size",r.subscriptSizing==="dynamic");let a=r._getSubscriptMessageType();Hy(),BI((o=a)==="error"?16:o==="hint"?17:-1);}},dependencies:[On,Ln,Vn$1,Pn,bt],styles:[`.mdc-text-field {
  display: inline-flex;
  align-items: baseline;
  padding: 0 16px;
  position: relative;
  box-sizing: border-box;
  overflow: hidden;
  will-change: opacity, transform, color;
  border-top-left-radius: 4px;
  border-top-right-radius: 4px;
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 0;
}

.mdc-text-field__input {
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: 0;
  background: none;
  padding: 0;
  -moz-appearance: none;
  -webkit-appearance: none;
  height: 28px;
}
.mdc-text-field__input::-webkit-calendar-picker-indicator, .mdc-text-field__input::-webkit-search-cancel-button {
  display: none;
}
.mdc-text-field__input::-ms-clear {
  display: none;
}
.mdc-text-field__input:focus {
  outline: none;
}
.mdc-text-field__input:invalid {
  box-shadow: none;
}
.mdc-text-field__input::placeholder {
  opacity: 0;
}
.mdc-text-field__input::-moz-placeholder {
  opacity: 0;
}
.mdc-text-field__input::-webkit-input-placeholder {
  opacity: 0;
}
.mdc-text-field__input:-ms-input-placeholder {
  opacity: 0;
}
.mdc-text-field--no-label .mdc-text-field__input::placeholder, .mdc-text-field--focused .mdc-text-field__input::placeholder {
  opacity: 1;
}
.mdc-text-field--no-label .mdc-text-field__input::-moz-placeholder, .mdc-text-field--focused .mdc-text-field__input::-moz-placeholder {
  opacity: 1;
}
.mdc-text-field--no-label .mdc-text-field__input::-webkit-input-placeholder, .mdc-text-field--focused .mdc-text-field__input::-webkit-input-placeholder {
  opacity: 1;
}
.mdc-text-field--no-label .mdc-text-field__input:-ms-input-placeholder, .mdc-text-field--focused .mdc-text-field__input:-ms-input-placeholder {
  opacity: 1;
}
.mdc-text-field--disabled:not(.mdc-text-field--no-label) .mdc-text-field__input.mat-mdc-input-disabled-interactive::placeholder {
  opacity: 0;
}
.mdc-text-field--disabled:not(.mdc-text-field--no-label) .mdc-text-field__input.mat-mdc-input-disabled-interactive::-moz-placeholder {
  opacity: 0;
}
.mdc-text-field--disabled:not(.mdc-text-field--no-label) .mdc-text-field__input.mat-mdc-input-disabled-interactive::-webkit-input-placeholder {
  opacity: 0;
}
.mdc-text-field--disabled:not(.mdc-text-field--no-label) .mdc-text-field__input.mat-mdc-input-disabled-interactive:-ms-input-placeholder {
  opacity: 0;
}
.mdc-text-field--outlined .mdc-text-field__input, .mdc-text-field--filled.mdc-text-field--no-label .mdc-text-field__input {
  height: 100%;
}
.mdc-text-field--outlined .mdc-text-field__input {
  display: flex;
  border: none !important;
  background-color: transparent;
}
.mdc-text-field--disabled .mdc-text-field__input {
  pointer-events: auto;
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-text-field__input {
  color: var(--mat-form-field-filled-input-text-color, var(--mat-sys-on-surface));
  caret-color: var(--mat-form-field-filled-caret-color, var(--mat-sys-primary));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-text-field__input::placeholder {
  color: var(--mat-form-field-filled-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-text-field__input::-moz-placeholder {
  color: var(--mat-form-field-filled-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-text-field__input::-webkit-input-placeholder {
  color: var(--mat-form-field-filled-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-text-field__input:-ms-input-placeholder {
  color: var(--mat-form-field-filled-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-text-field__input {
  color: var(--mat-form-field-outlined-input-text-color, var(--mat-sys-on-surface));
  caret-color: var(--mat-form-field-outlined-caret-color, var(--mat-sys-primary));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-text-field__input::placeholder {
  color: var(--mat-form-field-outlined-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-text-field__input::-moz-placeholder {
  color: var(--mat-form-field-outlined-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-text-field__input::-webkit-input-placeholder {
  color: var(--mat-form-field-outlined-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-text-field__input:-ms-input-placeholder {
  color: var(--mat-form-field-outlined-input-text-placeholder-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled.mdc-text-field--invalid:not(.mdc-text-field--disabled) .mdc-text-field__input {
  caret-color: var(--mat-form-field-filled-error-caret-color, var(--mat-sys-error));
}
.mdc-text-field--outlined.mdc-text-field--invalid:not(.mdc-text-field--disabled) .mdc-text-field__input {
  caret-color: var(--mat-form-field-outlined-error-caret-color, var(--mat-sys-error));
}
.mdc-text-field--filled.mdc-text-field--disabled .mdc-text-field__input {
  color: var(--mat-form-field-filled-disabled-input-text-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mdc-text-field--outlined.mdc-text-field--disabled .mdc-text-field__input {
  color: var(--mat-form-field-outlined-disabled-input-text-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
@media (forced-colors: active) {
  .mdc-text-field--disabled .mdc-text-field__input {
    background-color: Window;
  }
}

.mdc-text-field--filled {
  height: 56px;
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 0;
  border-top-left-radius: var(--mat-form-field-filled-container-shape, var(--mat-sys-corner-extra-small));
  border-top-right-radius: var(--mat-form-field-filled-container-shape, var(--mat-sys-corner-extra-small));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) {
  background-color: var(--mat-form-field-filled-container-color, var(--mat-sys-surface-variant));
}
.mdc-text-field--filled.mdc-text-field--disabled {
  background-color: var(--mat-form-field-filled-disabled-container-color, color-mix(in srgb, var(--mat-sys-on-surface) 4%, transparent));
}

.mdc-text-field--outlined {
  height: 56px;
  overflow: visible;
  padding-right: max(16px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small)));
  padding-left: max(16px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small)) + 4px);
}
[dir=rtl] .mdc-text-field--outlined {
  padding-right: max(16px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small)) + 4px);
  padding-left: max(16px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small)));
}

.mdc-floating-label {
  position: absolute;
  left: 0;
  transform-origin: left top;
  line-height: 1.15rem;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
  overflow: hidden;
  will-change: transform;
}
[dir=rtl] .mdc-floating-label {
  right: 0;
  left: auto;
  transform-origin: right top;
  text-align: right;
}
.mdc-text-field .mdc-floating-label {
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}
.mdc-notched-outline .mdc-floating-label {
  display: inline-block;
  position: relative;
  max-width: 100%;
}
.mdc-text-field--outlined .mdc-floating-label {
  left: 4px;
  right: auto;
}
[dir=rtl] .mdc-text-field--outlined .mdc-floating-label {
  left: auto;
  right: 4px;
}
.mdc-text-field--filled .mdc-floating-label {
  left: 16px;
  right: auto;
}
[dir=rtl] .mdc-text-field--filled .mdc-floating-label {
  left: auto;
  right: 16px;
}
.mdc-text-field--disabled .mdc-floating-label {
  cursor: default;
}
@media (forced-colors: active) {
  .mdc-text-field--disabled .mdc-floating-label {
    z-index: 1;
  }
}
.mdc-text-field--filled.mdc-text-field--no-label .mdc-floating-label {
  display: none;
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-floating-label {
  color: var(--mat-form-field-filled-label-text-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--focused .mdc-floating-label {
  color: var(--mat-form-field-filled-focus-label-text-color, var(--mat-sys-primary));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled):not(.mdc-text-field--focused):hover .mdc-floating-label {
  color: var(--mat-form-field-filled-hover-label-text-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled.mdc-text-field--disabled .mdc-floating-label {
  color: var(--mat-form-field-filled-disabled-label-text-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--invalid .mdc-floating-label {
  color: var(--mat-form-field-filled-error-label-text-color, var(--mat-sys-error));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--invalid.mdc-text-field--focused .mdc-floating-label {
  color: var(--mat-form-field-filled-error-focus-label-text-color, var(--mat-sys-error));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--invalid:not(.mdc-text-field--disabled):hover .mdc-floating-label {
  color: var(--mat-form-field-filled-error-hover-label-text-color, var(--mat-sys-on-error-container));
}
.mdc-text-field--filled .mdc-floating-label {
  font-family: var(--mat-form-field-filled-label-text-font, var(--mat-sys-body-large-font));
  font-size: var(--mat-form-field-filled-label-text-size, var(--mat-sys-body-large-size));
  font-weight: var(--mat-form-field-filled-label-text-weight, var(--mat-sys-body-large-weight));
  letter-spacing: var(--mat-form-field-filled-label-text-tracking, var(--mat-sys-body-large-tracking));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mdc-floating-label {
  color: var(--mat-form-field-outlined-label-text-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--focused .mdc-floating-label {
  color: var(--mat-form-field-outlined-focus-label-text-color, var(--mat-sys-primary));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled):not(.mdc-text-field--focused):hover .mdc-floating-label {
  color: var(--mat-form-field-outlined-hover-label-text-color, var(--mat-sys-on-surface));
}
.mdc-text-field--outlined.mdc-text-field--disabled .mdc-floating-label {
  color: var(--mat-form-field-outlined-disabled-label-text-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid .mdc-floating-label {
  color: var(--mat-form-field-outlined-error-label-text-color, var(--mat-sys-error));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid.mdc-text-field--focused .mdc-floating-label {
  color: var(--mat-form-field-outlined-error-focus-label-text-color, var(--mat-sys-error));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid:not(.mdc-text-field--disabled):hover .mdc-floating-label {
  color: var(--mat-form-field-outlined-error-hover-label-text-color, var(--mat-sys-on-error-container));
}
.mdc-text-field--outlined .mdc-floating-label {
  font-family: var(--mat-form-field-outlined-label-text-font, var(--mat-sys-body-large-font));
  font-size: var(--mat-form-field-outlined-label-text-size, var(--mat-sys-body-large-size));
  font-weight: var(--mat-form-field-outlined-label-text-weight, var(--mat-sys-body-large-weight));
  letter-spacing: var(--mat-form-field-outlined-label-text-tracking, var(--mat-sys-body-large-tracking));
}

.mdc-floating-label--float-above {
  cursor: auto;
  transform: translateY(-106%) scale(0.75);
}
.mdc-text-field--filled .mdc-floating-label--float-above {
  transform: translateY(-106%) scale(0.75);
}
.mdc-text-field--outlined .mdc-floating-label--float-above {
  transform: translateY(-37.25px) scale(1);
  font-size: 0.75rem;
}
.mdc-notched-outline .mdc-floating-label--float-above {
  text-overflow: clip;
}
.mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  max-width: 133.3333333333%;
}
.mdc-text-field--outlined.mdc-notched-outline--upgraded .mdc-floating-label--float-above, .mdc-text-field--outlined .mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  transform: translateY(-34.75px) scale(0.75);
}
.mdc-text-field--outlined.mdc-notched-outline--upgraded .mdc-floating-label--float-above, .mdc-text-field--outlined .mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  font-size: 1rem;
}

.mdc-floating-label--required:not(.mdc-floating-label--hide-required-marker)::after {
  margin-left: 1px;
  margin-right: 0;
  content: "*";
}
[dir=rtl] .mdc-floating-label--required:not(.mdc-floating-label--hide-required-marker)::after {
  margin-left: 0;
  margin-right: 1px;
}

.mdc-notched-outline {
  display: flex;
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  height: 100%;
  text-align: left;
  pointer-events: none;
}
[dir=rtl] .mdc-notched-outline {
  text-align: right;
}
.mdc-text-field--outlined .mdc-notched-outline {
  z-index: 1;
}

.mat-mdc-notch-piece {
  box-sizing: border-box;
  height: 100%;
  pointer-events: none;
  border: none;
  border-top: 1px solid;
  border-bottom: 1px solid;
}
.mdc-text-field--focused .mat-mdc-notch-piece {
  border-width: 2px;
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled) .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-outline-color, var(--mat-sys-outline));
  border-width: var(--mat-form-field-outlined-outline-width, 1px);
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled):not(.mdc-text-field--focused):hover .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-hover-outline-color, var(--mat-sys-on-surface));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--focused .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-focus-outline-color, var(--mat-sys-primary));
}
.mdc-text-field--outlined.mdc-text-field--disabled .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-disabled-outline-color, color-mix(in srgb, var(--mat-sys-on-surface) 12%, transparent));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-error-outline-color, var(--mat-sys-error));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid:not(.mdc-text-field--focused):hover .mdc-notched-outline .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-error-hover-outline-color, var(--mat-sys-on-error-container));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--invalid.mdc-text-field--focused .mat-mdc-notch-piece {
  border-color: var(--mat-form-field-outlined-error-focus-outline-color, var(--mat-sys-error));
}
.mdc-text-field--outlined:not(.mdc-text-field--disabled).mdc-text-field--focused .mdc-notched-outline .mat-mdc-notch-piece {
  border-width: var(--mat-form-field-outlined-focus-outline-width, 2px);
}

.mdc-notched-outline__leading {
  border-left: 1px solid;
  border-right: none;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-top-left-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
  border-bottom-left-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
}
.mdc-text-field--outlined .mdc-notched-outline .mdc-notched-outline__leading {
  width: max(12px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small)));
}
[dir=rtl] .mdc-notched-outline__leading {
  border-left: none;
  border-right: 1px solid;
  border-bottom-left-radius: 0;
  border-top-left-radius: 0;
  border-top-right-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
  border-bottom-right-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
}

.mdc-notched-outline__trailing {
  flex-grow: 1;
  border-left: none;
  border-right: 1px solid;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-top-right-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
  border-bottom-right-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
}
[dir=rtl] .mdc-notched-outline__trailing {
  border-left: 1px solid;
  border-right: none;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-top-left-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
  border-bottom-left-radius: var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small));
}

.mdc-notched-outline__notch {
  flex: 0 0 auto;
  width: auto;
}
.mdc-text-field--outlined .mdc-notched-outline .mdc-notched-outline__notch {
  max-width: min(var(--mat-form-field-notch-max-width, 100%), calc(100% - max(12px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small))) * 2));
}
.mdc-text-field--outlined .mdc-notched-outline--notched .mdc-notched-outline__notch {
  max-width: min(100%, calc(100% - max(12px, var(--mat-form-field-outlined-container-shape, var(--mat-sys-corner-extra-small))) * 2));
}
.mdc-text-field--outlined .mdc-notched-outline--notched .mdc-notched-outline__notch {
  padding-top: 1px;
}
.mdc-text-field--focused.mdc-text-field--outlined .mdc-notched-outline--notched .mdc-notched-outline__notch {
  padding-top: 2px;
}
.mdc-notched-outline--notched .mdc-notched-outline__notch {
  padding-left: 0;
  padding-right: 8px;
  border-top: none;
}
[dir=rtl] .mdc-notched-outline--notched .mdc-notched-outline__notch {
  padding-left: 8px;
  padding-right: 0;
}
.mdc-notched-outline--no-label .mdc-notched-outline__notch {
  display: none;
}

.mdc-line-ripple::before, .mdc-line-ripple::after {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  border-bottom-style: solid;
  content: "";
}
.mdc-line-ripple::before {
  z-index: 1;
  border-bottom-width: var(--mat-form-field-filled-active-indicator-height, 1px);
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-line-ripple::before {
  border-bottom-color: var(--mat-form-field-filled-active-indicator-color, var(--mat-sys-on-surface-variant));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled):not(.mdc-text-field--focused):hover .mdc-line-ripple::before {
  border-bottom-color: var(--mat-form-field-filled-hover-active-indicator-color, var(--mat-sys-on-surface));
}
.mdc-text-field--filled.mdc-text-field--disabled .mdc-line-ripple::before {
  border-bottom-color: var(--mat-form-field-filled-disabled-active-indicator-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--invalid .mdc-line-ripple::before {
  border-bottom-color: var(--mat-form-field-filled-error-active-indicator-color, var(--mat-sys-error));
}
.mdc-text-field--filled:not(.mdc-text-field--disabled).mdc-text-field--invalid:not(.mdc-text-field--focused):hover .mdc-line-ripple::before {
  border-bottom-color: var(--mat-form-field-filled-error-hover-active-indicator-color, var(--mat-sys-on-error-container));
}
.mdc-line-ripple::after {
  transform: scaleX(0);
  opacity: 0;
  z-index: 2;
}
.mdc-text-field--filled .mdc-line-ripple::after {
  border-bottom-width: var(--mat-form-field-filled-focus-active-indicator-height, 2px);
}
.mdc-text-field--filled:not(.mdc-text-field--disabled) .mdc-line-ripple::after {
  border-bottom-color: var(--mat-form-field-filled-focus-active-indicator-color, var(--mat-sys-primary));
}
.mdc-text-field--filled.mdc-text-field--invalid:not(.mdc-text-field--disabled) .mdc-line-ripple::after {
  border-bottom-color: var(--mat-form-field-filled-error-focus-active-indicator-color, var(--mat-sys-error));
}

.mdc-line-ripple--active::after {
  transform: scaleX(1);
  opacity: 1;
}

.mdc-line-ripple--deactivating::after {
  opacity: 0;
}

.mdc-text-field--disabled {
  pointer-events: none;
}

.mat-mdc-form-field-textarea-control {
  vertical-align: middle;
  resize: vertical;
  box-sizing: border-box;
  height: auto;
  margin: 0;
  padding: 0;
  border: none;
  overflow: auto;
}

.mat-mdc-form-field-input-control.mat-mdc-form-field-input-control {
  -moz-osx-font-smoothing: grayscale;
  -webkit-font-smoothing: antialiased;
  font: inherit;
  letter-spacing: inherit;
  text-decoration: inherit;
  text-transform: inherit;
  border: none;
}

.mat-mdc-form-field .mat-mdc-floating-label.mdc-floating-label {
  -moz-osx-font-smoothing: grayscale;
  -webkit-font-smoothing: antialiased;
  line-height: normal;
  pointer-events: all;
  will-change: auto;
}

.mat-mdc-form-field:not(.mat-form-field-disabled) .mat-mdc-floating-label.mdc-floating-label {
  cursor: inherit;
}

.mdc-text-field--no-label:not(.mdc-text-field--textarea) .mat-mdc-form-field-input-control.mdc-text-field__input,
.mat-mdc-text-field-wrapper .mat-mdc-form-field-input-control {
  height: auto;
}

.mat-mdc-text-field-wrapper .mat-mdc-form-field-input-control.mdc-text-field__input[type=color] {
  height: 23px;
}

.mat-mdc-text-field-wrapper {
  height: auto;
  flex: auto;
  will-change: auto;
}

.mat-mdc-form-field-has-icon-prefix .mat-mdc-text-field-wrapper {
  padding-left: 0;
  --mat-mdc-form-field-label-offset-x: -16px;
}

.mat-mdc-form-field-has-icon-suffix .mat-mdc-text-field-wrapper {
  padding-right: 0;
}

[dir=rtl] .mat-mdc-text-field-wrapper {
  padding-left: 16px;
  padding-right: 16px;
}
[dir=rtl] .mat-mdc-form-field-has-icon-suffix .mat-mdc-text-field-wrapper {
  padding-left: 0;
}
[dir=rtl] .mat-mdc-form-field-has-icon-prefix .mat-mdc-text-field-wrapper {
  padding-right: 0;
}

.mat-form-field-disabled .mdc-text-field__input::placeholder {
  color: var(--mat-form-field-disabled-input-text-placeholder-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mat-form-field-disabled .mdc-text-field__input::-moz-placeholder {
  color: var(--mat-form-field-disabled-input-text-placeholder-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mat-form-field-disabled .mdc-text-field__input::-webkit-input-placeholder {
  color: var(--mat-form-field-disabled-input-text-placeholder-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mat-form-field-disabled .mdc-text-field__input:-ms-input-placeholder {
  color: var(--mat-form-field-disabled-input-text-placeholder-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}

.mat-mdc-form-field-label-always-float .mdc-text-field__input::placeholder {
  transition-delay: 40ms;
  transition-duration: 110ms;
  opacity: 1;
}

.mat-mdc-text-field-wrapper .mat-mdc-form-field-infix .mat-mdc-floating-label {
  left: auto;
  right: auto;
}

.mat-mdc-text-field-wrapper.mdc-text-field--outlined .mdc-text-field__input {
  display: inline-block;
}

.mat-mdc-form-field .mat-mdc-text-field-wrapper.mdc-text-field .mdc-notched-outline__notch {
  padding-top: 0;
}

.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field .mdc-notched-outline__notch {
  border-left: 1px solid transparent;
}

[dir=rtl] .mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field.mat-mdc-form-field .mdc-notched-outline__notch {
  border-left: none;
  border-right: 1px solid transparent;
}

.mat-mdc-form-field-infix {
  min-height: var(--mat-form-field-container-height, 56px);
  padding-top: var(--mat-form-field-filled-with-label-container-padding-top, 24px);
  padding-bottom: var(--mat-form-field-filled-with-label-container-padding-bottom, 8px);
}
.mdc-text-field--outlined .mat-mdc-form-field-infix, .mdc-text-field--no-label .mat-mdc-form-field-infix {
  padding-top: var(--mat-form-field-container-vertical-padding, 16px);
  padding-bottom: var(--mat-form-field-container-vertical-padding, 16px);
}

.mat-mdc-text-field-wrapper .mat-mdc-form-field-flex .mat-mdc-floating-label {
  top: calc(var(--mat-form-field-container-height, 56px) / 2);
}

.mdc-text-field--filled .mat-mdc-floating-label {
  display: var(--mat-form-field-filled-label-display, block);
}

.mat-mdc-text-field-wrapper.mdc-text-field--outlined .mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  --mat-mdc-form-field-label-transform: translateY(calc(calc(6.75px + var(--mat-form-field-container-height, 56px) / 2) * -1))
    scale(var(--mat-mdc-form-field-floating-label-scale, 0.75));
  transform: var(--mat-mdc-form-field-label-transform);
}

@keyframes _mat-form-field-subscript-animation {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.mat-mdc-form-field-subscript-wrapper {
  box-sizing: border-box;
  width: 100%;
  position: relative;
}

.mat-mdc-form-field-hint-wrapper,
.mat-mdc-form-field-error-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 0 16px;
  opacity: 1;
  transform: translateY(0);
  animation: _mat-form-field-subscript-animation 0ms cubic-bezier(0.55, 0, 0.55, 0.2);
}

.mat-mdc-form-field-subscript-dynamic-size .mat-mdc-form-field-hint-wrapper,
.mat-mdc-form-field-subscript-dynamic-size .mat-mdc-form-field-error-wrapper {
  position: static;
}

.mat-mdc-form-field-bottom-align::before {
  content: "";
  display: inline-block;
  height: 16px;
}

.mat-mdc-form-field-bottom-align.mat-mdc-form-field-subscript-dynamic-size::before {
  content: unset;
}

.mat-mdc-form-field-hint-end {
  order: 1;
}

.mat-mdc-form-field-hint-wrapper {
  display: flex;
}

.mat-mdc-form-field-hint-spacer {
  flex: 1 0 1em;
}

.mat-mdc-form-field-error {
  display: block;
  color: var(--mat-form-field-error-text-color, var(--mat-sys-error));
}

.mat-mdc-form-field-subscript-wrapper,
.mat-mdc-form-field-bottom-align::before {
  -moz-osx-font-smoothing: grayscale;
  -webkit-font-smoothing: antialiased;
  font-family: var(--mat-form-field-subscript-text-font, var(--mat-sys-body-small-font));
  line-height: var(--mat-form-field-subscript-text-line-height, var(--mat-sys-body-small-line-height));
  font-size: var(--mat-form-field-subscript-text-size, var(--mat-sys-body-small-size));
  letter-spacing: var(--mat-form-field-subscript-text-tracking, var(--mat-sys-body-small-tracking));
  font-weight: var(--mat-form-field-subscript-text-weight, var(--mat-sys-body-small-weight));
}

.mat-mdc-form-field-focus-overlay {
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  position: absolute;
  opacity: 0;
  pointer-events: none;
  background-color: var(--mat-form-field-state-layer-color, var(--mat-sys-on-surface));
}
.mat-mdc-text-field-wrapper:hover .mat-mdc-form-field-focus-overlay {
  opacity: var(--mat-form-field-hover-state-layer-opacity, var(--mat-sys-hover-state-layer-opacity));
}
.mat-mdc-form-field.mat-focused .mat-mdc-form-field-focus-overlay {
  opacity: var(--mat-form-field-focus-state-layer-opacity, 0);
}

select.mat-mdc-form-field-input-control {
  -moz-appearance: none;
  -webkit-appearance: none;
  background-color: transparent;
  display: inline-flex;
  box-sizing: border-box;
}
select.mat-mdc-form-field-input-control:not(:disabled) {
  cursor: pointer;
}
select.mat-mdc-form-field-input-control:not(.mat-mdc-native-select-inline) option {
  color: var(--mat-form-field-select-option-text-color, var(--mat-sys-neutral10));
}
select.mat-mdc-form-field-input-control:not(.mat-mdc-native-select-inline) option:disabled {
  color: var(--mat-form-field-select-disabled-option-text-color, color-mix(in srgb, var(--mat-sys-neutral10) 38%, transparent));
}

.mat-mdc-form-field-type-mat-native-select .mat-mdc-form-field-infix::after {
  content: "";
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 5px solid;
  position: absolute;
  right: 0;
  top: 50%;
  margin-top: -2.5px;
  pointer-events: none;
  color: var(--mat-form-field-enabled-select-arrow-color, var(--mat-sys-on-surface-variant));
}
[dir=rtl] .mat-mdc-form-field-type-mat-native-select .mat-mdc-form-field-infix::after {
  right: auto;
  left: 0;
}
.mat-mdc-form-field-type-mat-native-select.mat-focused .mat-mdc-form-field-infix::after {
  color: var(--mat-form-field-focus-select-arrow-color, var(--mat-sys-primary));
}
.mat-mdc-form-field-type-mat-native-select.mat-form-field-disabled .mat-mdc-form-field-infix::after {
  color: var(--mat-form-field-disabled-select-arrow-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mat-mdc-form-field-type-mat-native-select .mat-mdc-form-field-input-control {
  padding-right: 15px;
}
[dir=rtl] .mat-mdc-form-field-type-mat-native-select .mat-mdc-form-field-input-control {
  padding-right: 0;
  padding-left: 15px;
}

@media (forced-colors: active) {
  .mat-form-field-appearance-fill .mat-mdc-text-field-wrapper {
    outline: solid 1px;
  }
}
@media (forced-colors: active) {
  .mat-form-field-appearance-fill.mat-form-field-disabled .mat-mdc-text-field-wrapper {
    outline-color: GrayText;
  }
}

@media (forced-colors: active) {
  .mat-form-field-appearance-fill.mat-focused .mat-mdc-text-field-wrapper {
    outline: dashed 3px;
  }
}

@media (forced-colors: active) {
  .mat-mdc-form-field.mat-focused .mdc-notched-outline {
    border: dashed 3px;
  }
}

.mat-mdc-form-field-input-control[type=date], .mat-mdc-form-field-input-control[type=datetime], .mat-mdc-form-field-input-control[type=datetime-local], .mat-mdc-form-field-input-control[type=month], .mat-mdc-form-field-input-control[type=week], .mat-mdc-form-field-input-control[type=time] {
  line-height: 1;
}
.mat-mdc-form-field-input-control::-webkit-datetime-edit {
  line-height: 1;
  padding: 0;
  margin-bottom: -2px;
}

.mat-mdc-form-field {
  --mat-mdc-form-field-floating-label-scale: 0.75;
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
  text-align: left;
  -moz-osx-font-smoothing: grayscale;
  -webkit-font-smoothing: antialiased;
  font-family: var(--mat-form-field-container-text-font, var(--mat-sys-body-large-font));
  line-height: var(--mat-form-field-container-text-line-height, var(--mat-sys-body-large-line-height));
  font-size: var(--mat-form-field-container-text-size, var(--mat-sys-body-large-size));
  letter-spacing: var(--mat-form-field-container-text-tracking, var(--mat-sys-body-large-tracking));
  font-weight: var(--mat-form-field-container-text-weight, var(--mat-sys-body-large-weight));
}
.mat-mdc-form-field .mdc-text-field--outlined .mdc-floating-label--float-above {
  font-size: calc(var(--mat-form-field-outlined-label-text-populated-size) * var(--mat-mdc-form-field-floating-label-scale));
}
.mat-mdc-form-field .mdc-text-field--outlined .mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  font-size: var(--mat-form-field-outlined-label-text-populated-size);
}
[dir=rtl] .mat-mdc-form-field {
  text-align: right;
}

.mat-mdc-form-field-flex {
  display: inline-flex;
  align-items: baseline;
  box-sizing: border-box;
  width: 100%;
}

.mat-mdc-text-field-wrapper {
  width: 100%;
  z-index: 0;
}

.mat-mdc-form-field-icon-prefix,
.mat-mdc-form-field-icon-suffix {
  align-self: center;
  line-height: 0;
  pointer-events: auto;
  position: relative;
  z-index: 1;
}
.mat-mdc-form-field-icon-prefix > .mat-icon,
.mat-mdc-form-field-icon-suffix > .mat-icon {
  padding: 0 12px;
  box-sizing: content-box;
}

.mat-mdc-form-field-icon-prefix {
  color: var(--mat-form-field-leading-icon-color, var(--mat-sys-on-surface-variant));
}
.mat-form-field-disabled .mat-mdc-form-field-icon-prefix {
  color: var(--mat-form-field-disabled-leading-icon-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}

.mat-mdc-form-field-icon-suffix {
  color: var(--mat-form-field-trailing-icon-color, var(--mat-sys-on-surface-variant));
}
.mat-form-field-disabled .mat-mdc-form-field-icon-suffix {
  color: var(--mat-form-field-disabled-trailing-icon-color, color-mix(in srgb, var(--mat-sys-on-surface) 38%, transparent));
}
.mat-form-field-invalid .mat-mdc-form-field-icon-suffix {
  color: var(--mat-form-field-error-trailing-icon-color, var(--mat-sys-error));
}
.mat-form-field-invalid:not(.mat-focused):not(.mat-form-field-disabled) .mat-mdc-text-field-wrapper:hover .mat-mdc-form-field-icon-suffix {
  color: var(--mat-form-field-error-hover-trailing-icon-color, var(--mat-sys-on-error-container));
}
.mat-form-field-invalid.mat-focused .mat-mdc-text-field-wrapper .mat-mdc-form-field-icon-suffix {
  color: var(--mat-form-field-error-focus-trailing-icon-color, var(--mat-sys-error));
}

.mat-mdc-form-field-icon-prefix,
[dir=rtl] .mat-mdc-form-field-icon-suffix {
  padding: 0 4px 0 0;
}

.mat-mdc-form-field-icon-suffix,
[dir=rtl] .mat-mdc-form-field-icon-prefix {
  padding: 0 0 0 4px;
}

.mat-mdc-form-field-subscript-wrapper .mat-icon,
.mat-mdc-form-field label .mat-icon {
  width: 1em;
  height: 1em;
  font-size: inherit;
}

.mat-mdc-form-field-infix {
  flex: auto;
  min-width: 0;
  width: 180px;
  position: relative;
  box-sizing: border-box;
}
.mat-mdc-form-field-infix:has(textarea[cols]) {
  width: auto;
}

.mat-mdc-form-field .mdc-notched-outline__notch {
  margin-left: -1px;
  -webkit-clip-path: inset(-9em -999em -9em 1px);
  clip-path: inset(-9em -999em -9em 1px);
}
[dir=rtl] .mat-mdc-form-field .mdc-notched-outline__notch {
  margin-left: 0;
  margin-right: -1px;
  -webkit-clip-path: inset(-9em 1px -9em -999em);
  clip-path: inset(-9em 1px -9em -999em);
}

.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-floating-label {
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field__input {
  transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field__input::placeholder {
  transition: opacity 67ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field__input::-moz-placeholder {
  transition: opacity 67ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field__input::-webkit-input-placeholder {
  transition: opacity 67ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field__input:-ms-input-placeholder {
  transition: opacity 67ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--no-label .mdc-text-field__input::placeholder, .mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--focused .mdc-text-field__input::placeholder {
  transition-delay: 40ms;
  transition-duration: 110ms;
}
.mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--no-label .mdc-text-field__input::-moz-placeholder, .mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--focused .mdc-text-field__input::-moz-placeholder {
  transition-delay: 40ms;
  transition-duration: 110ms;
}
.mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--no-label .mdc-text-field__input::-webkit-input-placeholder, .mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--focused .mdc-text-field__input::-webkit-input-placeholder {
  transition-delay: 40ms;
  transition-duration: 110ms;
}
.mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--no-label .mdc-text-field__input:-ms-input-placeholder, .mat-mdc-form-field.mat-form-field-animations-enabled.mdc-text-field--focused .mdc-text-field__input:-ms-input-placeholder {
  transition-delay: 40ms;
  transition-duration: 110ms;
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-text-field--filled:not(.mdc-ripple-upgraded):focus .mdc-text-field__ripple::before {
  transition-duration: 75ms;
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mdc-line-ripple::after {
  transition: transform 180ms cubic-bezier(0.4, 0, 0.2, 1), opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
.mat-mdc-form-field.mat-form-field-animations-enabled .mat-mdc-form-field-hint-wrapper,
.mat-mdc-form-field.mat-form-field-animations-enabled .mat-mdc-form-field-error-wrapper {
  animation-duration: 300ms;
}

.mdc-notched-outline .mdc-floating-label {
  max-width: calc(100% + 1px);
}

.mdc-notched-outline--upgraded .mdc-floating-label--float-above {
  max-width: calc(133.3333333333% + 1px);
}
`],encapsulation:2})}return n})();var Ct=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({imports:[In$1,Hn,Ba]})}return n})();var hr=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275cmp=vI({type:n,selectors:[["ng-component"]],hostAttrs:["cdk-text-field-style-loader",""],decls:0,vars:0,template:function(i,r){},styles:[`textarea.cdk-textarea-autosize {
  resize: none;
}

textarea.cdk-textarea-autosize-measuring {
  padding: 2px 0 !important;
  box-sizing: content-box !important;
  height: auto !important;
  overflow: hidden !important;
}

textarea.cdk-textarea-autosize-measuring-firefox {
  padding: 2px 0 !important;
  box-sizing: content-box !important;
  height: 0 !important;
}

@keyframes cdk-text-field-autofill-start { /*!*/ }
@keyframes cdk-text-field-autofill-end { /*!*/ }
.cdk-text-field-autofill-monitored:-webkit-autofill {
  animation: cdk-text-field-autofill-start 0s 1ms;
}

.cdk-text-field-autofill-monitored:not(:-webkit-autofill) {
  animation: cdk-text-field-autofill-end 0s 1ms;
}
`],encapsulation:2})}return n})(),pr={passive:true},Gn=(()=>{class n{_platform=w(An$1);_ngZone=w(Ce);_renderer=w(or$1).createRenderer(null,null);_styleLoader=w(V);_monitoredElements=new Map;monitor(e){if(!this._platform.isBrowser)return ht$1;this._styleLoader.load(hr);let i=j(e),r=this._monitoredElements.get(i);if(r)return r.subject;let o=new ee$1,a="cdk-text-field-autofilled",l=d=>{d.animationName==="cdk-text-field-autofill-start"&&!i.classList.contains(a)?(i.classList.add(a),this._ngZone.run(()=>o.next({target:d.target,isAutofilled:true}))):d.animationName==="cdk-text-field-autofill-end"&&i.classList.contains(a)&&(i.classList.remove(a),this._ngZone.run(()=>o.next({target:d.target,isAutofilled:false})));},c=this._ngZone.runOutsideAngular(()=>(i.classList.add("cdk-text-field-autofill-monitored"),this._renderer.listen(i,"animationstart",l,pr)));return this._monitoredElements.set(i,{subject:o,unlisten:c}),o}stopMonitoring(e){let i=j(e),r=this._monitoredElements.get(i);r&&(r.unlisten(),r.subject.complete(),i.classList.remove("cdk-text-field-autofill-monitored"),i.classList.remove("cdk-text-field-autofilled"),this._monitoredElements.delete(i));}ngOnDestroy(){this._monitoredElements.forEach((e,i)=>this.stopMonitoring(i));}static \u0275fac=function(i){return new(i||n)};static \u0275prov=cr$1({token:n,factory:n.\u0275fac})}return n})();var Un=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({})}return n})();var $n=new x("MAT_INPUT_VALUE_ACCESSOR");var qn=(()=>{class n{isErrorState(e,i){return !!(e&&e.invalid&&(e.touched||i&&i.submitted))}static \u0275fac=function(i){return new(i||n)};static \u0275prov=cr$1({token:n,factory:n.\u0275fac})}return n})();var Qe=class{_defaultMatcher;ngControl;_parentFormGroup;_parentForm;_stateChanges;errorState=false;matcher;constructor(t,e,i,r,o){this._defaultMatcher=t,this.ngControl=e,this._parentFormGroup=i,this._parentForm=r,this._stateChanges=o;}updateErrorState(){let t=this.errorState,e=this._parentFormGroup||this._parentForm,i=this.matcher||this._defaultMatcher,r=this.ngControl?this.ngControl.control:null,o=i?.isErrorState(r,e)??false;o!==t&&(this.errorState=o,this._stateChanges.next());}};var gr=["button","checkbox","file","hidden","image","radio","range","reset","submit"],_r=new x("MAT_INPUT_CONFIG"),ca=(()=>{class n{_elementRef=w(lr$1);_platform=w(An$1);ngControl=w(W,{optional:true,self:true});_autofillMonitor=w(Gn);_ngZone=w(Ce);_formField=w(xt,{optional:true});_renderer=w(Cv);_uid=w(yt$1).getId("mat-input-");_previousNativeValue;_inputValueAccessor;_signalBasedValueAccessor;_previousPlaceholder=null;_errorStateTracker;_config=w(_r,{optional:true});_cleanupIosKeyup;_cleanupWebkitWheel;_isServer=false;_isNativeSelect=false;_isTextarea=false;_isInFormField=false;focused=false;stateChanges=new ee$1;controlType="mat-input";autofilled=false;get disabled(){return this._disabled}set disabled(e){this._disabled=fs(e),this.focused&&(this.focused=false,this.stateChanges.next());}_disabled=false;get id(){return this._id}set id(e){this._id=e||this._uid;}_id;placeholder;name;get required(){return this._required??this.ngControl?.control?.hasValidator(xe.required)??false}set required(e){this._required=fs(e);}_required;get type(){return this._type}set type(e){this._type=e||"text",this._validateType(),!this._isTextarea&&cs().has(this._type)&&(this._elementRef.nativeElement.type=this._type);}_type="text";get errorStateMatcher(){return this._errorStateTracker.matcher}set errorStateMatcher(e){this._errorStateTracker.matcher=e;}userAriaDescribedBy;get value(){return this._signalBasedValueAccessor?this._signalBasedValueAccessor.value():this._inputValueAccessor.value}set value(e){e!==this.value&&(this._signalBasedValueAccessor?this._signalBasedValueAccessor.value.set(e):this._inputValueAccessor.value=e,this.stateChanges.next());}get readonly(){return this._readonly}set readonly(e){this._readonly=fs(e);}_readonly=false;disabledInteractive;get errorState(){return this._errorStateTracker.errorState}set errorState(e){this._errorStateTracker.errorState=e;}_neverEmptyInputTypes=["date","datetime","datetime-local","month","time","week"].filter(e=>cs().has(e));constructor(){let e=w(pt,{optional:true}),i=w(gt,{optional:true}),r=w(qn),o=w($n,{optional:true,self:true}),a=this._elementRef.nativeElement,l=a.nodeName.toLowerCase();o?So(o.value)?this._signalBasedValueAccessor=o:this._inputValueAccessor=o:this._inputValueAccessor=a,this._previousNativeValue=this.value,this.id=this.id,this._platform.IOS&&this._ngZone.runOutsideAngular(()=>{this._cleanupIosKeyup=this._renderer.listen(a,"keyup",this._iOSKeyupListener);}),this._errorStateTracker=new Qe(r,this.ngControl,i,e,this.stateChanges),this._isServer=!this._platform.isBrowser,this._isNativeSelect=l==="select",this._isTextarea=l==="textarea",this._isInFormField=!!this._formField,this.disabledInteractive=this._config?.disabledInteractive||false,this._isNativeSelect&&(this.controlType=a.multiple?"mat-native-select-multiple":"mat-native-select"),this._signalBasedValueAccessor&&gu(()=>{this._signalBasedValueAccessor.value(),this.stateChanges.next();});}ngAfterViewInit(){this._platform.isBrowser&&this._autofillMonitor.monitor(this._elementRef.nativeElement).subscribe(e=>{this.autofilled=e.isAutofilled,this.stateChanges.next();});}ngOnChanges(){this.stateChanges.next();}ngOnDestroy(){this.stateChanges.complete(),this._platform.isBrowser&&this._autofillMonitor.stopMonitoring(this._elementRef.nativeElement),this._cleanupIosKeyup?.(),this._cleanupWebkitWheel?.();}ngDoCheck(){this.ngControl&&(this.updateErrorState(),this.ngControl.disabled!==null&&this.ngControl.disabled!==this.disabled&&(this.disabled=this.ngControl.disabled,this.stateChanges.next())),this._dirtyCheckNativeValue(),this._dirtyCheckPlaceholder();}focus(e){this._elementRef.nativeElement.focus(e);}updateErrorState(){this._errorStateTracker.updateErrorState();}_focusChanged(e){if(e!==this.focused){if(!this._isNativeSelect&&e&&this.disabled&&this.disabledInteractive){let i=this._elementRef.nativeElement;i.type==="number"?(i.type="text",i.setSelectionRange(0,0),i.type="number"):i.setSelectionRange(0,0);}this.focused=e,this.stateChanges.next();}}_onInput(){}_dirtyCheckNativeValue(){let e=this._elementRef.nativeElement.value;this._previousNativeValue!==e&&(this._previousNativeValue=e,this.stateChanges.next());}_dirtyCheckPlaceholder(){let e=this._getPlaceholder();if(e!==this._previousPlaceholder){let i=this._elementRef.nativeElement;this._previousPlaceholder=e,e?i.setAttribute("placeholder",e):i.removeAttribute("placeholder");}}_getPlaceholder(){return this.placeholder||null}_validateType(){gr.indexOf(this._type)>-1;}_isNeverEmpty(){return this._neverEmptyInputTypes.indexOf(this._type)>-1}_isBadInput(){let e=this._elementRef.nativeElement.validity;return e&&e.badInput}get empty(){return !this._isNeverEmpty()&&!this._elementRef.nativeElement.value&&!this._isBadInput()&&!this.autofilled}get shouldLabelFloat(){if(this._isNativeSelect){let e=this._elementRef.nativeElement,i=e.options[0];return this.focused||e.multiple||!this.empty||!!(e.selectedIndex>-1&&i&&i.label)}else return this.focused&&!this.disabled||!this.empty}get describedByIds(){return this._elementRef.nativeElement.getAttribute("aria-describedby")?.split(" ")||[]}setDescribedByIds(e){let i=this._elementRef.nativeElement;e.length?i.setAttribute("aria-describedby",e.join(" ")):i.removeAttribute("aria-describedby");}onContainerClick(){this.focused||this.focus();}_isInlineSelect(){let e=this._elementRef.nativeElement;return this._isNativeSelect&&(e.multiple||e.size>1)}_iOSKeyupListener=e=>{let i=e.target;!i.value&&i.selectionStart===0&&i.selectionEnd===0&&(i.setSelectionRange(1,1),i.setSelectionRange(0,0));};_getReadonlyAttribute(){return this._isNativeSelect?null:this.readonly||this.disabled&&this.disabledInteractive?"true":null}static \u0275fac=function(i){return new(i||n)};static \u0275dir=TI({type:n,selectors:[["input","matInput",""],["textarea","matInput",""],["select","matNativeControl",""],["input","matNativeControl",""],["textarea","matNativeControl",""]],hostAttrs:[1,"mat-mdc-input-element"],hostVars:21,hostBindings:function(i,r){i&1&&op("focus",function(){return r._focusChanged(true)})("blur",function(){return r._focusChanged(false)})("input",function(){return r._onInput()}),i&2&&(np("id",r.id)("disabled",r.disabled&&!r.disabledInteractive)("required",r.required),Yf("name",r.name||null)("readonly",r._getReadonlyAttribute())("aria-disabled",r.disabled&&r.disabledInteractive?"true":null)("aria-invalid",r.empty&&r.required?null:r.errorState)("aria-required",r.required)("id",r.id),hp("mat-input-server",r._isServer)("mat-mdc-form-field-textarea-control",r._isInFormField&&r._isTextarea)("mat-mdc-form-field-input-control",r._isInFormField)("mat-mdc-input-disabled-interactive",r.disabledInteractive)("mdc-text-field__input",r._isInFormField)("mat-mdc-native-select-inline",r._isInlineSelect()));},inputs:{disabled:"disabled",id:"id",placeholder:"placeholder",name:"name",required:"required",type:"type",errorStateMatcher:"errorStateMatcher",userAriaDescribedBy:[0,"aria-describedby","userAriaDescribedBy"],value:"value",readonly:"readonly",disabledInteractive:[2,"disabledInteractive","disabledInteractive",UP]},exportAs:["matInput"],features:[GE([{provide:yt,useExisting:n}]),Ug]})}return n})(),ua=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({imports:[Ct,Ct,Un,Ba]})}return n})();var vr=["*"];var br=new x("MAT_CARD_CONFIG"),ya=(()=>{class n{appearance;constructor(){let e=w(br,{optional:true});this.appearance=e?.appearance||"raised";}static \u0275fac=function(i){return new(i||n)};static \u0275cmp=vI({type:n,selectors:[["mat-card"]],hostAttrs:[1,"mat-mdc-card","mdc-card"],hostVars:8,hostBindings:function(i,r){i&2&&hp("mat-mdc-card-outlined",r.appearance==="outlined")("mdc-card--outlined",r.appearance==="outlined")("mat-mdc-card-filled",r.appearance==="filled")("mdc-card--filled",r.appearance==="filled");},inputs:{appearance:"appearance"},exportAs:["matCard"],ngContentSelectors:vr,decls:1,vars:0,template:function(i,r){i&1&&(sE(),aE(0));},styles:[`.mat-mdc-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  position: relative;
  border-style: solid;
  border-width: 0;
  background-color: var(--mat-card-elevated-container-color, var(--mat-sys-surface-container-low));
  border-color: var(--mat-card-elevated-container-color, var(--mat-sys-surface-container-low));
  border-radius: var(--mat-card-elevated-container-shape, var(--mat-sys-corner-medium));
  box-shadow: var(--mat-card-elevated-container-elevation, var(--mat-sys-level1));
}
.mat-mdc-card::after {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: solid 1px transparent;
  content: "";
  display: block;
  pointer-events: none;
  box-sizing: border-box;
  border-radius: var(--mat-card-elevated-container-shape, var(--mat-sys-corner-medium));
}

.mat-mdc-card-outlined {
  background-color: var(--mat-card-outlined-container-color, var(--mat-sys-surface));
  border-radius: var(--mat-card-outlined-container-shape, var(--mat-sys-corner-medium));
  border-width: var(--mat-card-outlined-outline-width, 1px);
  border-color: var(--mat-card-outlined-outline-color, var(--mat-sys-outline-variant));
  box-shadow: var(--mat-card-outlined-container-elevation, var(--mat-sys-level0));
}
.mat-mdc-card-outlined::after {
  border: none;
}

.mat-mdc-card-filled {
  background-color: var(--mat-card-filled-container-color, var(--mat-sys-surface-container-highest));
  border-radius: var(--mat-card-filled-container-shape, var(--mat-sys-corner-medium));
  box-shadow: var(--mat-card-filled-container-elevation, var(--mat-sys-level0));
}

.mdc-card__media {
  position: relative;
  box-sizing: border-box;
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
}
.mdc-card__media::before {
  display: block;
  content: "";
}
.mdc-card__media:first-child {
  border-top-left-radius: inherit;
  border-top-right-radius: inherit;
}
.mdc-card__media:last-child {
  border-bottom-left-radius: inherit;
  border-bottom-right-radius: inherit;
}

.mat-mdc-card-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  box-sizing: border-box;
  min-height: 52px;
  padding: 8px;
}

.mat-mdc-card-title {
  font-family: var(--mat-card-title-text-font, var(--mat-sys-title-large-font));
  line-height: var(--mat-card-title-text-line-height, var(--mat-sys-title-large-line-height));
  font-size: var(--mat-card-title-text-size, var(--mat-sys-title-large-size));
  letter-spacing: var(--mat-card-title-text-tracking, var(--mat-sys-title-large-tracking));
  font-weight: var(--mat-card-title-text-weight, var(--mat-sys-title-large-weight));
}

.mat-mdc-card-subtitle {
  color: var(--mat-card-subtitle-text-color, var(--mat-sys-on-surface));
  font-family: var(--mat-card-subtitle-text-font, var(--mat-sys-title-medium-font));
  line-height: var(--mat-card-subtitle-text-line-height, var(--mat-sys-title-medium-line-height));
  font-size: var(--mat-card-subtitle-text-size, var(--mat-sys-title-medium-size));
  letter-spacing: var(--mat-card-subtitle-text-tracking, var(--mat-sys-title-medium-tracking));
  font-weight: var(--mat-card-subtitle-text-weight, var(--mat-sys-title-medium-weight));
}

.mat-mdc-card-title,
.mat-mdc-card-subtitle {
  display: block;
  margin: 0;
}
.mat-mdc-card-avatar ~ .mat-mdc-card-header-text .mat-mdc-card-title,
.mat-mdc-card-avatar ~ .mat-mdc-card-header-text .mat-mdc-card-subtitle {
  padding: 16px 16px 0;
}

.mat-mdc-card-header {
  display: flex;
  padding: 16px 16px 0;
}

.mat-mdc-card-content {
  display: block;
  padding: 0 16px;
}
.mat-mdc-card-content:first-child {
  padding-top: 16px;
}
.mat-mdc-card-content:last-child {
  padding-bottom: 16px;
}

.mat-mdc-card-title-group {
  display: flex;
  justify-content: space-between;
  width: 100%;
}

.mat-mdc-card-avatar {
  height: 40px;
  width: 40px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-bottom: 16px;
  object-fit: cover;
}
.mat-mdc-card-avatar ~ .mat-mdc-card-header-text .mat-mdc-card-subtitle,
.mat-mdc-card-avatar ~ .mat-mdc-card-header-text .mat-mdc-card-title {
  line-height: normal;
}

.mat-mdc-card-sm-image {
  width: 80px;
  height: 80px;
}

.mat-mdc-card-md-image {
  width: 112px;
  height: 112px;
}

.mat-mdc-card-lg-image {
  width: 152px;
  height: 152px;
}

.mat-mdc-card-xl-image {
  width: 240px;
  height: 240px;
}

.mat-mdc-card-subtitle ~ .mat-mdc-card-title,
.mat-mdc-card-title ~ .mat-mdc-card-subtitle,
.mat-mdc-card-header .mat-mdc-card-header-text .mat-mdc-card-title,
.mat-mdc-card-header .mat-mdc-card-header-text .mat-mdc-card-subtitle,
.mat-mdc-card-title-group .mat-mdc-card-title,
.mat-mdc-card-title-group .mat-mdc-card-subtitle {
  padding-top: 0;
}

.mat-mdc-card-content > :last-child:not(.mat-mdc-card-footer) {
  margin-bottom: 0;
}

.mat-mdc-card-actions-align-end {
  justify-content: flex-end;
}
`],encapsulation:2})}return n})();var xa=(()=>{class n{static \u0275fac=function(i){return new(i||n)};static \u0275mod=EI({type:n});static \u0275inj=wl({imports:[Ba]})}return n})();var yr="https://www.warcraftlogs.com/api/v2/user",xr={1:"DeathKnight",2:"Druid",3:"Hunter",4:"Mage",5:"Monk",6:"Paladin",7:"Priest",8:"Rogue",9:"Shaman",10:"Warlock",11:"Warrior",12:"DemonHunter",13:"Evoker"},Cr=`
query($code:String!){reportData{report(code:$code){
  title
  fights(killType:All){id name startTime endTime kill encounterID difficulty friendlyPlayers}
  masterData{
    actors(type:"Player"){id name subType server}
    abilities{gameID name icon}
  }
}}}`,Dr=`
query($code:String!,$fightIDs:[Int]!){
  reportData{report(code:$code){playerDetails(fightIDs:$fightIDs)}}
}`,wr=`
query($code:String!,$fightIDs:[Int]!,$dataType:EventDataType,$sourceID:Int,$startTime:Float,$endTime:Float){
  reportData{report(code:$code){
    events(fightIDs:$fightIDs,dataType:$dataType,sourceID:$sourceID,
           startTime:$startTime,endTime:$endTime,limit:10000){data nextPageTimestamp}
  }}
}`,Mr="{userData{currentUser{characters{id name serverSlug serverRegion}}}}",Fr=`
query($name:String!,$serverSlug:String!,$serverRegion:String!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    name classID
    recentReports(limit:5){data{code startTime}}
  }}
}`,Ar=`
query($name:String!,$serverSlug:String!,$serverRegion:String!,$encID:Int!){
  characterData{character(name:$name,serverSlug:$serverSlug,serverRegion:$serverRegion){
    encounterRankings(encounterID:$encID,includeCombatantInfo:true)
  }}
}`,Wn=class n{auth=w(_n$1);async query(t,e={}){let i=this.auth.getToken();if(!i)throw this.auth.logout(),new Error('Not logged in to WCL \u2014 click "Sign In" to authorize.');let r=await fetch(yr,{method:"POST",headers:{Authorization:`Bearer ${i}`,"Content-Type":"application/json"},body:JSON.stringify({query:t,variables:e})});if(r.status===401)throw this.auth.logout(),new Error("WCL session expired \u2014 sign in again.");if(!r.ok)throw new Error(`WCL API error (${r.status})`);let o=await r.json();if(o.errors?.length)throw new Error(o.errors[0].message||"WCL GraphQL error");return o.data}async getReport(t){return (await this.query(Cr,{code:t})).reportData.report}async getPlayerDetails(t,e){let r=(await this.query(Dr,{code:t,fightIDs:[e]})).reportData.report.playerDetails,o=typeof r=="string"?JSON.parse(r):r,a=o?.data?.playerDetails??o??{},l={};for(let c of ["dps","healers","tanks","unknown"])for(let d of a[c]||[]){let _=(d.type||"").replace(/ /g,""),u=((d.specs||[])[0]?.spec||"").replace(/ /g,"");u&&_&&(l[d.id]=u+_),d.name&&(l[`name_${d.id}`]=d.name);}return l}async getAllEvents(t,e,i,r,o,a){let l=[],c=r;for(;;){let d={code:t,fightIDs:[e],dataType:i,startTime:c,endTime:o};a!=null&&(d.sourceID=a);let u=(await this.query(wr,d)).reportData.report.events;if(l.push(...u.data||[]),!u.nextPageTimestamp)break;c=u.nextPageTimestamp;}return l}async fetchUserCharacters(){let e=(await this.query(Mr))?.userData?.currentUser?.characters||[];try{localStorage.setItem("wcl_user_chars",JSON.stringify(e));}catch{}return e}getCachedUserChars(){try{return JSON.parse(localStorage.getItem("wcl_user_chars")||"[]")||[]}catch{return []}}async charLookup(t,e,i){let o=(await this.query(Fr,{name:t,serverSlug:e,serverRegion:i}))?.characterData?.character;if(!o)throw new Error(`Character not found: ${t}-${e} (${i})`);let a=null,l=null,c=o.recentReports?.data||[];if(!c.length)throw new Error("No recent WCL reports found for this character.");l=c[0].code;for(let d of c.slice(0,3))try{let _=await this.getReport(d.code),u=_.fights||[];if(!u.length)continue;let O=await this.getPlayerDetails(d.code,u[0].id),G=(_.masterData?.actors||[]).find(ue=>ue.name.toLowerCase()===o.name.toLowerCase());if(G&&O[G.id]){a=O[G.id],l=d.code;break}}catch{}return {name:o.name,spec:a,server:e,region:i,source_report:l}}async getCharGear(t,e,i,r){let a=(await this.query(Ar,{name:t,serverSlug:e,serverRegion:i,encID:r}))?.characterData?.character?.encounterRankings;if(a==null)throw new Error(`Character not found: ${t}-${e} (${i})`);let c=(typeof a=="string"?JSON.parse(a):a)?.ranks||[];if(!c.length)return {found:false,message:"No ranked kills found for this encounter."};let d=c.reduce((U,Ze)=>(Ze.startTime||0)>(U.startTime||0)?Ze:U),_=this._extractCombatantInfo(d),u=d.spec||"",O=d.class,G=xr[O]||"",ue=u&&G?u+G:u,Ce=[...new Set(_.enchants.filter(U=>U.id).map(U=>U.id))];if(Ce.length)try{let U=Ce.map(Q=>`e${Q}: enchant(id:${Q}){id name}`).join(" "),Kn=(await this.query(`query{gameData{${U}}}`))?.gameData||{};for(let Q of _.enchants)!Q.name&&Q.id&&(Q.name=Kn[`e${Q.id}`]?.name||"");}catch{}return $({found:true,spec:ue,source_report:d.report?.code||null},_)}_extractCombatantInfo(t){if(!t)return {talent_key:"",trinkets:[],enchants:[]};let e=t.gear||[],i=t.talents,r=[],o=[];e.forEach((l,c)=>{if(!l?.id)return;let d=typeof l.id=="string"?parseInt(l.id,10):l.id,_=l.name||"";(c===12||c===13)&&r.push({slot:c,id:d,name:_});let u=l.permanentEnchant;if(u){let O=typeof u=="string"?parseInt(u,10):u;o.push({slot:c,id:O,name:l.permanentEnchantName||""});}});let a="";if(typeof i=="string"&&i)a=i;else if(Array.isArray(i)&&i.length){let l=i.filter(c=>c?.talentID||c?.id).map(c=>c.talentID??c.id);l.length&&(a="v1:"+[...l].sort().join(","));}else if(i&&typeof i=="object"){let l=[];for(let c of ["class","spec"]){let d=i[c];if(!(!d||typeof d!="object")){for(let _ of Object.values(d))if(Array.isArray(_))for(let u of _){let O=u?.node?.nodeId??u.nodeId;O!=null&&l.push(O);}}}l.length&&(a="v2:"+[...new Set(l)].sort((c,d)=>c-d).join(","));}return {talent_key:a,trinkets:r,enchants:o}}static \u0275fac=function(e){return new(e||n)};static \u0275prov=ie({token:n,factory:n.\u0275fac,providedIn:"root"})};var Dt="/data/specs/",Qn=class n{async getEncounters(t){try{let e=await fetch(`${Dt}${t}/encounters.json`);if(e.ok)return (await e.json()).filter(r=>r.sample_count>0)}catch{}try{let e=await fetch(`/api/admin/parses/stats/${t}`);if(e.ok){let i=await e.json();return Object.entries(i.stats||{}).map(([r,o])=>({id:parseInt(r,10),name:o.encounter_name,sample_count:o.sample_count,last_ingested:o.last_ingested})).filter(r=>r.sample_count>0)}}catch{}return []}async getBench(t,e){try{let i=await fetch(`${Dt}${t}/encounters/${e}.json`);if(i.ok)return i.json()}catch{}try{let i=await fetch(`/api/pre/gear-stats/${t}/${e}`);if(i.ok)return i.json()}catch{}return null}async getRulebook(t){try{let e=await fetch(`${Dt}${t}/rulebook.json`);if(e.ok)return e.json()}catch{}return null}static \u0275fac=function(e){return new(e||n)};static \u0275prov=ie({token:n,factory:n.\u0275fac,providedIn:"root"})};var Zn=class n{auth=w(_n$1);signIn(){this.auth.login();}static \u0275fac=function(e){return new(e||n)};static \u0275cmp=vI({type:n,selectors:[["wl-auth-banner"]],decls:13,vars:0,consts:[[1,"auth-banner"],[1,"banner-icon"],["mat-flat-button","","color","primary",3,"click"]],template:function(e,i){e&1&&(oi$1(0,"div",0)(1,"mat-icon",1),OE(2,"lock_open"),yc(),oi$1(3,"h3"),OE(4,"Connect Warcraft Logs"),yc(),oi$1(5,"p"),OE(6," This analyzer fetches your combat data directly from Warcraft Logs."),Jf(7,"br"),OE(8," Sign in once and your browser remembers your session. "),yc(),oi$1(9,"button",2),op("click",function(){return i.signIn()}),oi$1(10,"mat-icon"),OE(11,"login"),yc(),OE(12," Sign in with Warcraft Logs "),yc()());},dependencies:[ea,ta,Oo,Io],styles:[".auth-banner[_ngcontent-%COMP%]{background:#c8a64f14;border:1px solid rgba(200,166,79,.3);border-radius:8px;padding:32px 24px;text-align:center;max-width:500px;margin:48px auto}.auth-banner[_ngcontent-%COMP%]   .banner-icon[_ngcontent-%COMP%]{font-size:48px;width:48px;height:48px;color:var(--gold);margin-bottom:12px}.auth-banner[_ngcontent-%COMP%]   h3[_ngcontent-%COMP%]{color:var(--gold);font-size:18px;margin-bottom:8px}.auth-banner[_ngcontent-%COMP%]   p[_ngcontent-%COMP%]{color:var(--muted);font-size:13px;margin-bottom:20px;line-height:1.6}"]})};var Xn=class n{transform(t){return t?t.replace(/([A-Z])/g," $1").trim():""}static \u0275fac=function(e){return new(e||n)};static \u0275pipe=CI({name:"formatSpec",type:n,pure:true})};var Yn=class n{transform(t){if(t==null)return "-";let e=Math.floor(t/60),i=Math.floor(t%60);return `${e}:${String(i).padStart(2,"0")}`}static \u0275fac=function(e){return new(e||n)};static \u0275pipe=CI({name:"formatDuration",type:n,pure:true})};export{Ct as C,Hn as H,Oi as O,Qr as Q,Wn as W,Xn as X,Yn as Y,Zn as Z,ua as a,Qn as b,ca as c,xt as d,W as e,xe as f,qn as g,gt as h,Qe as i,yt as j,pt as p,qr as q,un as u,vt as v,xa as x,ya as y};