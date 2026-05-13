BUN ?= bun

.PHONY: help test typecheck build build-binary binary clean

help:
	@printf '%s\n' 'Targets:'
	@printf '  %-14s %s\n' 'test' 'Run the Vitest suite'
	@printf '  %-14s %s\n' 'typecheck' 'Run TypeScript type checking'
	@printf '  %-14s %s\n' 'build' 'Build the JS distribution and copy assets'
	@printf '  %-14s %s\n' 'build-binary' 'Build the standalone linearctl binary'
	@printf '  %-14s %s\n' 'binary' 'Alias for build-binary'
	@printf '  %-14s %s\n' 'clean' 'Remove build output'

test:
	$(BUN) run test

typecheck:
	$(BUN) run typecheck

build:
	$(BUN) run build

build-binary:
	$(BUN) run build:binary

binary: build-binary

clean:
	rm -rf dist
