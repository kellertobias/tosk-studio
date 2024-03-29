import { AtemState, Commands } from "atem-connection";
import { ME } from "./constants";
import { AtemSubModule } from "./_sub";
import arrayEquals from '/server/backend/helpers/array-equals';

export interface TransitionTies {
    bg: boolean,
    usk1: boolean,
    usk2: boolean,
    usk3: boolean,
    usk4: boolean
}

export interface TransitionOnairs {
    usk1: boolean,
    usk2: boolean,
    usk3: boolean,
    usk4: boolean
}

export class AtemModuleUsk extends AtemSubModule {
    current : {
        ties: TransitionTies,
        onair: TransitionOnairs,
    } = {
        ties: {
            bg: false,
            usk1: false,
            usk2: false,
            usk3: false,
            usk4: false,
        },
        onair: {
            usk1: false,
            usk2: false,
            usk3: false,
            usk4: false,
        }
    }

    _getTies(inp: number, position: number) {
        return Math.floor(inp / position) % 2 == 1
    }

    setup(): Promise<void> {
        return Promise.resolve()
    }

    update(status: AtemState, pathToChange: string[]): Promise<void> {
        const video = status.video
        const me = video.mixEffects[0]
        if(!me) {
            this.parent.raiseError('No Video Mixer Status in last Message')
            return Promise.resolve()
        }

        const selection = me.transitionProperties.selection || 1

        const nextTies = {
            bg: this._getTies(selection, 1),
            usk1: this._getTies(selection, 2),
            usk2: this._getTies(selection, 4),
            usk3: this._getTies(selection, 8),
            usk4: this._getTies(selection, 16),
        }

        const nextOnair = {
            usk1: me.upstreamKeyers[0]?.onAir || false,
            usk2: me.upstreamKeyers[1]?.onAir || false,
            usk3: me.upstreamKeyers[2]?.onAir || false,
            usk4: me.upstreamKeyers[3]?.onAir || false,
        }

        const current = this.current

        this.current = {
            ties: nextTies,
            onair: nextOnair
        }

        if(
            !arrayEquals(Object.values(nextTies), Object.values(current.ties)) ||
            !arrayEquals(Object.values(nextOnair), Object.values(current.onair))
        ) {
            this.parent.runEventHandlers('tras-parts', {ties: nextTies, onair: nextOnair})
        }

        return Promise.resolve()
    }

    onChange(handler: ((param: {ties: TransitionTies, onair: TransitionOnairs}) => void)) {
        this.parent.registerEventHandler('tras-parts', handler)
    }

    tie = async (params: {usk: number, enable?: boolean}) => {
        let {usk, enable} = params
        const ties = Object.assign({}, this.current.ties)
        if(usk == 0) {
            if(enable == undefined) enable = !ties.bg
            ties.bg = enable
        }
        const uskKey : keyof TransitionOnairs = `usk${usk}` as keyof TransitionOnairs
        if(enable == undefined) enable = !ties[uskKey]
        ties[uskKey] = enable

        const style = this.parent.mix.current.style

        return this.parent.mix._transitionStyle(style, ties)
    }

    onair = async (params: {usk: number, enable?: boolean}) => {
        let {usk, enable} = params
        const uskKey : keyof TransitionOnairs = `usk${usk}` as keyof TransitionOnairs
        const oldValue = this.current.onair[uskKey]
        if(enable == undefined) enable = !oldValue
        const c = new Commands.MixEffectKeyOnAirCommand(ME, usk - 1, enable)
        return this.client.sendCommand(c)
    }


}