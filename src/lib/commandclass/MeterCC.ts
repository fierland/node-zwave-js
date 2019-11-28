import { lookupMeterScale, MeterScale } from "../config/Meters";
import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { validatePayload } from "../util/misc";
import {
	Maybe,
	parseBitMask,
	parseFloatWithScale,
	unknownNumber,
} from "../values/Primitive";
import {
	CCCommand,
	CCCommandOptions,
	ccValue,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

// All the supported commands
export enum MeterCommand {
	Get = 0x01,
	Report = 0x02,
	SupportedGet = 0x03,
	SupportedReport = 0x04,
	Reset = 0x05,
}

export enum RateType {
	Unspecified = 0x00,
	Consumed = 0x01,
	Produced = 0x02,
}

@commandClass(CommandClasses.Meter)
@implementedVersion(4)
export class MeterCC extends CommandClass {
	declare ccCommand: MeterCommand;
}

@CCCommand(MeterCommand.Report)
export class MeterCCReport extends MeterCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		validatePayload(this.payload.length >= 2);
		this._type = this.payload[0] & 0b0_00_11111;
		this._rateType = (this.payload[0] & 0b0_11_00000) >>> 5;
		const scale1Bit2 = (this.payload[0] & 0b1_00_00000) >>> 7;

		const { scale: scale1Bits10, value, bytesRead } = parseFloatWithScale(
			this.payload.slice(1),
		);
		let offset = 2 + bytesRead;
		// The scale is composed of two fields (see SDS13781)
		const scale1 = (scale1Bit2 << 2) | scale1Bits10;
		let scale2 = 0;
		this._value = value;

		if (this.version >= 2 && this.payload.length >= offset + 2) {
			this._deltaTime = this.payload.readUInt16BE(offset);
			offset += 2;
			if (this._deltaTime === 0xffff) {
				this._deltaTime = unknownNumber;
			}

			if (
				// 0 means that no previous value is included
				this.deltaTime !== 0 &&
				this.payload.length >= offset + bytesRead
			) {
				const { value: prevValue } = parseFloatWithScale(
					// This float is split in the payload
					Buffer.concat([
						Buffer.from([this.payload[1]]),
						this.payload.slice(offset),
					]),
				);
				offset += bytesRead;
				this._previousValue = prevValue;
			}
			if (
				this.version >= 4 &&
				scale1 === 7 &&
				this.payload.length >= offset + 1
			) {
				scale2 = this.payload[offset];
			}
		} else {
			// 0 means that no previous value is included
			this._deltaTime = 0;
		}
		const scale = scale1 === 7 ? scale1 + scale2 : scale1;
		this._scale = lookupMeterScale(this._type, scale);
	}

	private _type: number;
	public get type(): number {
		return this._type;
	}

	private _scale: MeterScale;
	public get scale(): MeterScale {
		return this._scale;
	}

	private _value: number;
	public get value(): number {
		return this._value;
	}

	private _previousValue: number | undefined;
	public get previousValue(): number | undefined {
		return this._previousValue;
	}

	private _rateType: RateType;
	public get rateType(): RateType {
		return this._rateType;
	}

	private _deltaTime: Maybe<number>;
	public get deltaTime(): Maybe<number> {
		return this._deltaTime;
	}
}

interface MeterCCGetOptions extends CCCommandOptions {
	scale?: number;
	rateType?: RateType;
}

@CCCommand(MeterCommand.Get)
@expectedCCResponse(MeterCCReport)
export class MeterCCGet extends MeterCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | MeterCCGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.rateType = options.rateType;
			this.scale = options.scale;
		}
	}

	public rateType: RateType | undefined;
	public scale: number | undefined;

	public serialize(): Buffer {
		let scale1: number;
		let scale2: number | undefined;
		let bufferLength = 0;

		if (this.scale == undefined) {
			scale1 = 0;
		} else if (this.version >= 4 && this.scale >= 7) {
			scale1 = 7;
			scale2 = this.scale >>> 3;
			bufferLength = 2;
		} else if (this.version >= 3) {
			scale1 = this.scale & 0b111;
			bufferLength = 1;
		} else if (this.version >= 2) {
			scale1 = this.scale & 0b11;
			bufferLength = 1;
		} else {
			scale1 = 0;
		}

		let rateTypeFlags = 0;
		if (this.version >= 4 && this.rateType != undefined) {
			rateTypeFlags = this.rateType & 0b11;
			bufferLength = Math.max(bufferLength, 1);
		}

		this.payload = Buffer.alloc(bufferLength, 0);
		this.payload[0] = (rateTypeFlags << 6) | (scale1 << 3);
		if (scale2) this.payload[1] = scale2;

		return super.serialize();
	}
}

@CCCommand(MeterCommand.SupportedReport)
export class MeterCCSupportedReport extends MeterCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 2);
		this._type = this.payload[0] & 0b0_00_11111;
		this._supportsReset = !!(this.payload[0] & 0b1_00_00000);
		const hasMoreScales = !!(this.payload[1] & 0b1_0000000);
		if (hasMoreScales) {
			// The bitmask is spread out
			validatePayload(this.payload.length >= 3);
			const extraBytes = this.payload[2];
			validatePayload(this.payload.length >= 3 + extraBytes);
			// The bitmask is the original payload byte plus all following bytes
			// Since the first byte only has 7 bits, we need to reduce all following bits by 1
			this._supportedScales = parseBitMask(
				Buffer.concat([
					Buffer.from([this.payload[1] & 0b0_1111111]),
					this.payload.slice(3, 3 + extraBytes),
				]),
				0,
			).map(scale => (scale >= 8 ? scale - 1 : scale));
		} else {
			// only 7 bits in the bitmask. Bit 7 is 0, so no need to mask it out
			this._supportedScales = parseBitMask(
				Buffer.from([this.payload[1]]),
				0,
			);
		}
		// This is only present in V4+
		this._supportedRateTypes = parseBitMask(
			Buffer.from([(this.payload[0] & 0b0_11_00000) >>> 5]),
			1,
		);
	}

	private _type: number;
	public get type(): number {
		return this._type;
	}

	private _supportsReset: boolean;
	@ccValue({ internal: true })
	public get supportsReset(): boolean {
		return this._supportsReset;
	}

	private _supportedScales: number[];
	public get supportedScales(): readonly number[] {
		return this._supportedScales;
	}

	private _supportedRateTypes: RateType[];
	public get supportedRateTypes(): readonly RateType[] {
		return this._supportedRateTypes;
	}
}

@CCCommand(MeterCommand.SupportedGet)
@expectedCCResponse(MeterCCSupportedReport)
export class MeterCCSupportedGet extends MeterCC {}

@CCCommand(MeterCommand.Reset)
export class MeterCCReset extends MeterCC {}
