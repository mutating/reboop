.PHONY: lint test mutate check build
.NOTPARALLEL: check

lint:
	npm run lint

test:
	npm test

mutate:
	npm run mutate

check:
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) mutate

build:
	npm run build

