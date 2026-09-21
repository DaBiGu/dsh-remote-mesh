@echo off
rem Stand-in for nginx.exe so the deployment test can run on a machine without nginx.
node "%~dp0fake-nginx.mjs" %*
