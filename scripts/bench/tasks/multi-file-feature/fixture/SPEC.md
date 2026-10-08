# Inventory

validation.mjs: validateItem(item) checks nonempty id/name, integer quantity >=0, finite price >=0. Throws on invalid input.
inventory.mjs: createInventory() provides add, update(id,patch), remove(id), list. Reject duplicates and updates of missing IDs; list returns copies. IDs cannot change.
search.mjs: search(items,query), case insensitive name substring.
summary.mjs: summary(items) returns {units,value}.
csv.mjs: exportCsv(items), id,name,quantity,price header; quote commas/quotes/newlines and double quotes. Final newline.
storage.mjs: save(adapter,items), load(adapter) using key inventory, getItem/setItem. Missing/invalid JSON yields [].
render.mjs: render(items) produces HTML list, escaping names.
index.mjs: re-export createInventory, search, summary, exportCsv, save, load, render.
