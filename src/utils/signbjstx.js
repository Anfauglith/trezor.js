/* @flow */
'use strict';

import * as bitcoin from 'bitcoinjs-lib-zcash';
import * as trezor from '../trezortypes';
import * as hdnodeUtils from './hdnode';

import type Session, {MessageResponse} from '../session';

export type OutputInfo = {
    path: Array<number>;
    value: number;
} | {
    address: string;
    value: number;
};

export type InputInfo = {
    hash: Buffer;
    index: number;
    path?: Array<number>;
};

export type TxInfo = {
    inputs: Array<InputInfo>;
    outputs: Array<OutputInfo>;
};

function input2trezor(input: InputInfo): trezor.TransactionInput {
    const {hash, index, path} = input;
    return {
        prev_index: index,
        prev_hash: reverseBuffer(hash).toString('hex'),
        address_n: path,
    };
}

function _flow_makeArray(a: mixed): Array<number> {
    if (!(Array.isArray(a))) {
        throw new Error('Both address and path of an output cannot be null.');
    }
    const res: Array<number> = [];
    a.forEach(k => {
        if (typeof k === 'number') {
            res.push(k);
        }
    });
    return res;
}

function output2trezor(output: OutputInfo, network: bitcoin.Network): trezor.TransactionOutput {
    if (output.address == null) {
        if (!output.path) {
            throw new Error('Both address and path of an output cannot be null.');
        }

        const pathArr: Array<number> = _flow_makeArray(output.path);

        return {
            address_n: pathArr,
            amount: output.value,
            script_type: 'PAYTOADDRESS',
        };
    }
    const address = output.address;
    if (typeof address !== 'string') {
        throw new Error('Wrong type.');
    }
    const scriptType = getAddressScriptType(address, network);

    return {
        address: address,
        amount: output.value,
        script_type: scriptType,
    };
}

function signedTx2bjsTx(signedTx: MessageResponse<trezor.SignedTx>): bitcoin.Transaction {
    const res = bitcoin.Transaction.fromHex(signedTx.message.serialized.serialized_tx);
    return res;
}

function bjsTx2refTx(tx: bitcoin.Transaction): trezor.RefTransaction {
    const data = getJoinSplitData(tx);
    const dataStr = data == null ? null : data.toString('hex');
    return {
        lock_time: tx.locktime,
        version: tx.version,
        hash: tx.getId(),
        inputs: tx.ins.map((input: bitcoin.Input) => {
            return {
                prev_index: input.index,
                sequence: input.sequence,
                prev_hash: reverseBuffer(input.hash).toString('hex'),
                script_sig: input.script.toString('hex'),
            };
        }),
        bin_outputs: tx.outs.map((output: bitcoin.Output) => {
            return {
                amount: output.value,
                script_pubkey: output.script.toString('hex'),
            };
        }),
        extra_data: dataStr,
    };
}

function _flow_getPathOrAddress(output: OutputInfo): string | Array<number> {
    if (output.path) {
        const path = output.path;
        return _flow_makeArray(path);
    }
    if (typeof output.address === 'string') {
        return output.address;
    }
    throw new Error('Wrong output type.');
}

function deriveOutputScript(
    pathOrAddress: string | Array<number>,
    nodes: Array<bitcoin.HDNode>,
    network: bitcoin.Network
): Buffer {
    const scriptType = typeof pathOrAddress === 'string'
                        ? getAddressScriptType(pathOrAddress, network)
                        : 'PAYTOADDRESS';

    const pkh: Buffer = typeof pathOrAddress === 'string'
                                ? bitcoin.address.fromBase58Check(pathOrAddress).hash
                                : hdnodeUtils.derivePubKeyHash(
                                      nodes,
                                      pathOrAddress[pathOrAddress.length - 2],
                                      pathOrAddress[pathOrAddress.length - 1]
                                );

    if (scriptType === 'PAYTOADDRESS') {
        return bitcoin.script.pubKeyHashOutput(pkh);
    }
    if (scriptType === 'PAYTOSCRIPTHASH') {
        return bitcoin.script.scriptHashOutput(pkh);
    }
    throw new Error('Unknown script type ' + scriptType);
}

function verifyBjsTx(
    inputs: Array<InputInfo>,
    outputs: Array<OutputInfo>,
    nodes: Array<bitcoin.HDNode>,
    resTx: bitcoin.Transaction,
    network: bitcoin.Network
) {
    if (inputs.length !== resTx.ins.length) {
        throw new Error('Signed transaction has wrong length.');
    }
    if (outputs.length !== resTx.outs.length) {
        throw new Error('Signed transaction has wrong length.');
    }

    outputs.map((output, i) => {
        if (output.value !== resTx.outs[i].value) {
            throw new Error('Signed transaction has wrong output value.');
        }
        if (output.address == null && output.path == null) {
            throw new Error('Both path and address cannot be null.');
        }

        const addressOrPath = _flow_getPathOrAddress(output);
        const scriptA = deriveOutputScript(addressOrPath, nodes, network);
        const scriptB = resTx.outs[i].script;
        if (scriptA.compare(scriptB) !== 0) {
            throw new Error('Scripts differ');
        }
    });
}

function getAddressScriptType(address: string, network: bitcoin.Network): string {
    const decoded = bitcoin.address.fromBase58Check(address);
    if (decoded.version === network.pubKeyHash) {
        return 'PAYTOADDRESS';
    }
    if (decoded.version === network.scriptHash) {
        return 'PAYTOSCRIPTHASH';
    }
    throw new Error('Unknown address type.');
}

function getJoinSplitData(transaction: bitcoin.Transaction): ?Buffer {
    if (transaction.version < 2) {
        return null;
    }
    const buffer = transaction.toBuffer();
    const joinsplitByteLength = transaction.joinsplitByteLength();
    const res = buffer.slice(buffer.length - joinsplitByteLength);
    return res;
}

export function signBjsTx(
    session: Session,
    info: TxInfo,
    refTxs: Array<bitcoin.Transaction>,
    nodes: Array<bitcoin.HDNode>,
    coinName: string,
    network_: ?bitcoin.Network
): Promise<bitcoin.Transaction> {
    const network: bitcoin.Network = network_ == null ? bitcoin.networks[coinName.toLowerCase()] : network_;
    if (network == null) {
        return Promise.reject(new Error('No network ' + coinName));
    }

    const trezorInputs: Array<trezor.TransactionInput> = info.inputs.map(i => input2trezor(i));
    const trezorOutputs: Array<trezor.TransactionOutput> =
        info.outputs.map(o => output2trezor(o, network));
    const trezorRefTxs: Array<trezor.RefTransaction> = refTxs.map(tx => bjsTx2refTx(tx));

    return session.signTx(
        trezorInputs,
        trezorOutputs,
        trezorRefTxs,
        coinName
    ).then(tx => signedTx2bjsTx(tx))
    .then(res => {
        verifyBjsTx(info.inputs, info.outputs, nodes, res, network);
        return res;
    });
}

function reverseBuffer(buf: Buffer): Buffer {
    const copy = new Buffer(buf.length);
    buf.copy(copy);
    [].reverse.call(copy);
    return copy;
}
