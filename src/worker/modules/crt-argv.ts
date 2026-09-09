// Microsoft CRT argument rules (argv[0] comes separately from the PE name):
// https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
export function parseCrtArguments(command: string): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < command.length) {
        while (command[i] === ' ' || command[i] === '\t') i++;
        if (i === command.length) break;
        let value = '', quoted = false;
        while (i < command.length) {
            if (!quoted && (command[i] === ' ' || command[i] === '\t')) break;
            let slashes = 0;
            while (command[i] === '\\') { slashes++; i++; }
            if (command[i] === '"') {
                value += '\\'.repeat(slashes >> 1);
                if (slashes & 1) value += '"';
                else if (quoted && command[i + 1] === '"') { value += '"'; i++; }
                else quoted = !quoted;
                i++;
            } else {
                value += '\\'.repeat(slashes);
                if (i >= command.length || (!quoted && (command[i] === ' ' || command[i] === '\t'))) break;
                value += command[i++];
            }
        }
        result.push(value);
    }
    return result;
}

export function writeCrtArgv(
    values: Uint8Array[],
    alloc: (size: number) => number,
    writeBytes: (address: number, bytes: Uint8Array) => void,
    writeUint32: (address: number, value: number) => void,
): number {
    const pointerBytes = (values.length + 1) * 4;
    const base = alloc(pointerBytes + values.reduce((n, value) => n + value.length + 1, 0));
    let next = base + pointerBytes;
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        writeUint32(base + index * 4, next);
        writeBytes(next, value);
        writeBytes(next + value.length, new Uint8Array(1));
        next += value.length + 1;
    }
    writeUint32(base + values.length * 4, 0);
    return base;
}
