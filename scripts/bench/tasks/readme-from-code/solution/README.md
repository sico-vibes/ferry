# Tiny tools

Requires Node 22 or newer. ESM, no dependencies.

```js
import { slug, clamp } from './index.mjs';
slug('Hello Ferry'); // hello-ferry
clamp(12, 0, 10); // 10
```

slug(text) lowercases, trims, and replaces non-alphanumeric runs with hyphens.
clamp(value, min, max) bounds a number to the inclusive range; it throws RangeError when min > max.
