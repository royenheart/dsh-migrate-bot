# boot-break fixture

A counter-example for the boot check. It is a valid out-of-tree plugin package: `package.json` declares `dsh.bundle.patch`, the patch inserts its own row, and the module resolves. It fails only when the host applies it, which a typecheck cannot see.

Expected boot check outcome: `fail`, with the host naming the plugin.
