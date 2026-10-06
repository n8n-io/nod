#!/bin/sh
for argument do
  shift
  case "$argument" in
  [0-9]*x[0-9]*x[0-9]*) argument=1920x1080x24 ;;
  esac
  set -- "$@" "$argument"
done
exec /usr/bin/Xvfb "$@"
