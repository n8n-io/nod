.PHONY: analyze format test check build-linux

analyze:
	flutter analyze

format:
	dart format --output=none --set-exit-if-changed lib test integration_test tool

test:
	flutter test

check: format analyze test

build-linux:
	flutter build linux
