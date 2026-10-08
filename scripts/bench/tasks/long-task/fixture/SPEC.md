# Todo app

Implement these modules with named exports, no dependencies.
model.mjs: createTodo(id,title,due=null) validates nonempty string id/title, due null or YYYY-MM-DD; returns {id,title,done:false,archived:false,due}.
store.mjs: createStore(initial=[]) with add(todo), list() deep copies, update(id,patch) rejects missing IDs, remove(id). Add rejects duplicate IDs.
actions.mjs: toggle(store,id), rename(store,id,title) rejecting blank, archive(store,id).
filters.mjs: filter(items,mode) active = !done&&!archived, completed = done&&!archived, all = !archived, archived = archived.
search.mjs: search(items,query) case insensitive substring of title.
sort.mjs: sortTodos(items) due date ascending, null last, title as tie breaker, without mutation.
validation.mjs: parseCommand(line) for add <title>, done <id>, delete <id>, list; rejects others/missing arguments, returns {command,value}, value empty for list.
serialization.mjs: encode(items) => JSON {version:1,items}; decode(text) validates version and array, throws invalid.
persistence.mjs: save(adapter,items), load(adapter) using key todos; missing/corrupt yields [].
stats.mjs: stats(items) => {total,active,completed,archived} matching filters; total includes archived.
history.mjs: createHistory() with push(items), undo() LIFO snapshots, returns null when empty, deep copies.
render.mjs: render(items) returns escaped HTML with checkbox for each item; completed checkbox is checked.
app.mjs: createApp(adapter) with store, execute(line) applying parseCommand; add IDs String(max numeric id + 1), done toggle, delete remove, list returns list; persist after mutation.
cli.mjs: node cli.mjs add Buy milk prints JSON array containing the new todo; list prints []; unknown command exits 2. Use in-memory adapter.
index.html: self-contained small todo UI supporting add, toggle, delete and localStorage persistence, accessible labels.
Do not modify this spec, test.mjs or package.json.
