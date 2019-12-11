import * as express from 'express';
import * as HttpStatus from 'http-status-codes';

import { StakingDataService } from '../services/staking_data_service';
import { StakingEpochsResponse, StakingPoolsResponse, StakingStatsResponse } from '../types';

export class StakingHandlers {
    private readonly _stakingDataService: StakingDataService;
    public async getStakingPoolsAsync(_req: express.Request, res: express.Response): Promise<void> {
        const stakingPools = await this._stakingDataService.getStakingPoolsWithStatsAsync();
        const response: StakingPoolsResponse = {
            stakingPools,
        };
        res.status(HttpStatus.OK).send(response);
    }
    public async getStakingEpochsAsync(_req: express.Request, res: express.Response): Promise<void> {
        const [currentEpoch, nextEpoch] = await Promise.all([
            this._stakingDataService.getCurrentEpochAsync(),
            this._stakingDataService.getNextEpochAsync(),
        ]);
        const response: StakingEpochsResponse = {
            currentEpoch,
            nextEpoch,
        };
        res.status(HttpStatus.OK).send(response);
    }
    public async getStakingStatsAsync(_req: express.Request, res: express.Response): Promise<void> {
        const allTimeStakingStats = await this._stakingDataService.getAllTimeStakingStatsAsync();
        const response: StakingStatsResponse = {
            allTime: allTimeStakingStats,
        };
        res.status(HttpStatus.OK).send(response);
    }
    constructor(stakingDataService: StakingDataService) {
        this._stakingDataService = stakingDataService;
    }
}
