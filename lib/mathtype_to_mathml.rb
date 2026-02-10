#!/usr/bin/env ruby
require "base64"
require "mathtype_to_mathml_plus"

bin = Base64.decode64(STDIN.read)
puts MathtypeToMathmlPlus.convert(bin)
