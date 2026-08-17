#!/bin/sh

# Git 2.25 does not support GIT_CONFIG_GLOBAL/GIT_CONFIG_COUNT. Workers with an
# isolated HOME therefore cannot see the host .gitconfig entry installed by
# `gh auth setup-git`. Supply the same host gh credential through Git's stable
# askpass interface, but only for github.com prompts.
prompt=${1-}
case "$prompt" in
  *"://github.com'"*|*"://github.com/"*|*"@github.com'"*|*"@github.com/"*) ;;
  *) exit 1 ;;
esac

case "$prompt" in
  *sername*)
    printf '%s\n' 'x-access-token'
    ;;
  *assword*)
    exec gh auth token --hostname github.com
    ;;
  *)
    exit 1
    ;;
esac
