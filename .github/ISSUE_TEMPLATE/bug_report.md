---
name: Bug report
about: Something drift did that it should not have
title: ''
labels: bug
assignees: ''
---

**Postgres version**
<!-- SELECT version(); -->

**driftjs version**
<!-- drift --version -->

**Schema shape**
The three things above decide nearly every bug in this tool, and this one most of all.
Please include the `CREATE TABLE` for the tables involved, or at least:

- primary keys, or no primary key
- foreign keys, and whether any table references itself
- partitioned or inherited tables
- column types that are not `int` or `text` (`numeric`, `bytea`, `json`, arrays, dates)

**What you ran**

```
$ drift ...
```

**What happened**
<!-- The output, pasted as it was printed. -->

**What you expected instead**
