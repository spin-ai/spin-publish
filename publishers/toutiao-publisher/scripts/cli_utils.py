"""Argparse helper that keeps failures machine-readable under --json."""

import argparse
import json
import sys


class JsonArgumentParser(argparse.ArgumentParser):
    json_requested = False

    def error(self, message):
        if self.json_requested:
            print(
                json.dumps(
                    {"ok": False, "status": "invalid_arguments", "message": message},
                    ensure_ascii=False,
                )
            )
            self.print_usage(sys.stderr)
            self.exit(2)
        super().error(message)


def configure_json_argument_parser(argv):
    JsonArgumentParser.json_requested = "--json" in list(argv)
    return JsonArgumentParser
