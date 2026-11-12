# forms

Парсер форм SPXML/XMD.

## Разработка

```powershell
npm install
npm run lint
npm test
npm run typecheck
npm run verify:package
```


## Пример

```typescript
import { FormRegistry, resolveForm, findField } from '@wshcmx/forms';

const registry = new FormRegistry();
registry.register(`
  <SPXML-FORM>
    <named SAMPLE="1">
      <name TYPE="string" DEFAULT="Untitled"/>
    </named>
  </SPXML-FORM>
`, 'x-local://app/base.xmd');

const form = registry.register(`
  <SPXML-FORM>
    <USE FORM="base.xmd"/>
    <item TYPE="named">
      <name DEFAULT="Example"/>
      <enabled TYPE="bool" DEFAULT="true"/>
      <label PROPERTY="1" EXPR="return name;"/>
    </item>
  </SPXML-FORM>
`, 'x-local://app/item.xmd');

const result = resolveForm(form, registry);
console.log(result.kind, result.issues);
if (result.root) {
  console.log(findField(result.root, 'item.name')?.attrs['DEFAULT']);
}
```