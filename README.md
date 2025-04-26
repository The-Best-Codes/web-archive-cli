# web-archive-cli

Javascript CLI to archive websites and monitor archiving jobs progress.

## Installation

```bash
npm install -g web-archive-cli
```

## Usage

```bash
web-archive-cli # default
web-archive # alias
wa # alias
```

### Options

```bash
Usage: web-archive-cli [options] [url]

archive websites using the Internet Archive Save API

Arguments:
  url                    the URL to archive (omit to enter interactive mode)

Options:
  -V, --version          output the version number
  -k, --keep-protocol    keep http(s):// in URL (default: false)
  --debug                enable verbose debug output (default: false)
  -t, --timeout <ms>     polling timeout in milliseconds (default: 300000)
  --cache-buster <type>  append a cache-busting value: none, 'frag' for fragment, 'query' for query string (default: "none")
  -h, --help             display help for command
```
