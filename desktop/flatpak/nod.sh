#!/bin/sh
case "${XDG_CURRENT_DESKTOP:-}" in
  *KDE*) exec zypak-wrapper /app/nod/nod "$@" ;;
  *) exec zypak-wrapper /app/nod/nod --password-store=gnome-libsecret "$@" ;;
esac
