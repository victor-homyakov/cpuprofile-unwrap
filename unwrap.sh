input=$1
# profile.<id>.cpuprofile -> profile.<id>.fixed.cpuprofile
output=${input%.cpuprofile}.fixed.cpuprofile
npm run unwrap -- "$input" -o "$output" --stats
