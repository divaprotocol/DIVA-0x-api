import { LimitOrderFields } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import { getAddress } from '@ethersproject/address';
import * as _ from 'lodash';
import { Connection, In, MoreThanOrEqual } from 'typeorm';

import { LimitOrder, BalanceCheckerContract } from '../asset-swapper';
import { fetchPoolLists } from '../asset-swapper/utils/market_operation_utils/pools_cache/pool_list_cache';
import {
    DB_ORDERS_UPDATE_CHUNK_SIZE,
    SRA_ORDER_EXPIRATION_BUFFER_SECONDS,
    SRA_PERSISTENT_ORDER_POSTING_WHITELISTED_API_KEYS,
    defaultHttpServiceConfig,
} from '../config';
import {
    ONE_SECOND_MS,
    NULL_ADDRESS,
    DIVA_GOVERNANCE_ADDRESS,
    BALANCE_CHECKER_ADDRESS,
    BALANCE_CHECKER_GAS_LIMIT,
    EXCHANGE_PROXY_ADDRESS,
    ARRAY_LIMIT_LENGTH,
} from '../constants';
import { PersistentSignedOrderV4Entity, SignedOrderV4Entity } from '../entities';
import { ValidationError, ValidationErrorCodes, ValidationErrorReasons } from '../errors';
import { alertOnExpiredOrders } from '../logger';
import {
    OrderbookResponse,
    OrderEventEndState,
    PaginatedCollection,
    SignedLimitOrder,
    SRAOrder,
    OrderbookPriceRequest,
    OrderbookPriceResponse,
    MakerInfoType,
    FillableOrderType,
} from '../types';
import { orderUtils } from '../utils/order_utils';
import { OrderWatcherInterface } from '../utils/order_watcher';
import { paginationUtils } from '../utils/pagination_utils';
import { providerUtils } from '../utils/provider_utils';

export class OrderBookService {
    private readonly _connection: Connection;
    private readonly _orderWatcher: OrderWatcherInterface;
    public static isAllowedPersistentOrders(apiKey: string): boolean {
        return SRA_PERSISTENT_ORDER_POSTING_WHITELISTED_API_KEYS.includes(apiKey);
    }
    public async getOrderByHashIfExistsAsync(orderHash: string): Promise<SRAOrder | undefined> {
        let signedOrderEntity;
        signedOrderEntity = await this._connection.manager.findOne(SignedOrderV4Entity, orderHash);
        if (!signedOrderEntity) {
            signedOrderEntity = await this._connection.manager.findOne(PersistentSignedOrderV4Entity, orderHash);
        }
        if (signedOrderEntity === undefined) {
            return undefined;
        } else {
            return orderUtils.deserializeOrderToSRAOrder(signedOrderEntity as Required<SignedOrderV4Entity>);
        }
    }

    /**
     * The function to filter the order
     * @param {SRAOrder} order
     * @param {OrderbookPriceRequest} req
     * @returns {boolean}
     */
     public filterOrder = (order: SRAOrder,req: OrderbookPriceRequest): boolean => {
        // 1 is 0.001% and the actual amount is token fee / 100000, so we divided it by 100000
        // filter by taker token fee
        if (req.takerTokenFee !== -1) {
            const takerTokenFeeAmountExpected = order.order.takerAmount.multipliedBy(new BigNumber(req.takerTokenFee / 100000));

            if (order.order.taker === NULL_ADDRESS && // Ensure that orders are fillable by anyone and not reserved for a specific address
                order.order.feeRecipient === DIVA_GOVERNANCE_ADDRESS.toLowerCase() && // Ensure that the feeRecipient is DIVA Governance address
                (order.order.takerTokenFeeAmount.lte(takerTokenFeeAmountExpected.minus(1)) || // calculate the toleance
                order.order.takerTokenFeeAmount.gte(takerTokenFeeAmountExpected.plus(1)))
            ) {
                return false;
            }
            const toleranceTakerTokenFeeAmount = new BigNumber(1);

            if (order.order.takerTokenFeeAmount.lte(takerTokenFeeAmountExpected.minus(toleranceTakerTokenFeeAmount)) ||
                order.order.takerTokenFeeAmount.gte(takerTokenFeeAmountExpected.plus(toleranceTakerTokenFeeAmount))
            ) {
                return false;
            }
        }
        // filter by taker address
        if (req.taker !== NULL_ADDRESS && req.taker !== order.order.taker.toLowerCase()) {
            return false;
        }
        // filter by feeRecipent address
        if (req.feeRecipient !== NULL_ADDRESS && order.order.feeRecipient.toLowerCase() !== req.feeRecipient) {
            return false;
        }
        // filter by threshold
        if ((req.threshold !== 0 && order.metaData.remainingFillableTakerAmount.lte(req.threshold)) ||
            order.metaData.remainingFillableTakerAmount.lte(100)
        ) {
            return false;
        }

        return true;
    }

    /**
     * The function to format best bid & ask data type
     * @param {SRAOrder} record
     * @returns {OrderbookPriceResponse}
     */
    public getBidOrAskFormat = (record: SRAOrder): OrderbookPriceResponse => {
        return {
            order: {
                maker: getAddress(record.order.maker),
                taker: getAddress(record.order.taker),
                makerToken: getAddress(record.order.makerToken),
                takerToken: getAddress(record.order.takerToken),
                makerAmount: record.order.makerAmount,
                takerAmount: record.order.takerAmount,
                takerTokenFeeAmount: record.order.takerTokenFeeAmount,
                feeRecipient: getAddress(record.order.feeRecipient),
                expiry: record.order.expiry,
            },
            metaData: {
                remainingFillableTakerAmount: record.metaData.remainingFillableTakerAmount,
            }
        }
    }

    /**
     * The function to get maker address array and makerToken array
     * @param {SRAOrder[]} records
     * @returns {MakerInfoType}
     */
    public getMakerInfo = (records: SRAOrder[]): MakerInfoType => {
        // maker address array
        let makers: string[] = records.map((data) => {
            return data.order.maker
        });
        // makerToken array
        let makerTokens: string[] = records.map((data) => {
            return data.order.makerToken
        });

        return {
            makers,
            makerTokens,
        }
    }

    /**
     * The function to get the fillable order from order data
     * @param {string[]} makers // maker address array
     * @param {string[]} makerTokens // maker token address array
     * @param {BigNumber[]} minOfBalancesOrAllowances // min balances or allowances of every makers about every makerTokens
     * @param {SRAOrder} order // order data
     * @returns {FillableOrderType}
     */
    public getFillableOrder = (
        makers: string[],
        makerTokens: string[],
        minOfBalancesOrAllowances: BigNumber[],
        order: SRAOrder,
    ): FillableOrderType => {
		// Calculate remainingFillableMakerAmount using remainingFillableTakerAmount, makerAmount and takerAmount information received from 0x api
    	// This new variable is compared to the maker's maker token balance and allowance to assess fillability.
        const remainingFillableMakerAmount = order.order.makerAmount
            .multipliedBy(new BigNumber(order.metaData.remainingFillableTakerAmount))
            .div(order.order.takerAmount);
        let makerIndex: number = -1;

		// Find the index
        makers.map((maker: string, index: number) => {
            if (maker.toLowerCase() === order.order.maker.toLowerCase() &&
                makerTokens[index].toLowerCase() === order.order.makerToken.toLowerCase()) {
                makerIndex = index;
            }
        });

		// Get minimum of maker's maker token balance and allowance and include it as a new field in order metaData.
		// Note that remainingMakerMinOfBalancesOrAllowances is the minimum of full makerAllowance and balance for the first (best) order
		// and then decreases for the following orders as the remainingFillableMakerAmount gets reduced.
        const remainingMakerMinOfBalancesOrAllowances = minOfBalancesOrAllowances[makerIndex];

        if (remainingMakerMinOfBalancesOrAllowances.gt(0)) {
            let remainingFillableTakerAmount = order.metaData.remainingFillableTakerAmount;
			// remainingFillableMakerAmount is the minimum of remainingMakerMinOfBalancesOrAllowances and remainingFillableMakerAmount implied by remainingFillableTakerAmount.
      		// If remainingMakerMinOfBalancesOrAllowances < remainingFillableMakerAmount, then remainingFillableTakerAmount needs to be reduced as well.
            if (remainingFillableMakerAmount.gt(remainingMakerMinOfBalancesOrAllowances)) {
                remainingFillableTakerAmount =
                    remainingMakerMinOfBalancesOrAllowances
                    .multipliedBy(order.order.takerAmount)
                    .div(order.order.makerAmount);
            }

            minOfBalancesOrAllowances[makerIndex] =
                minOfBalancesOrAllowances[makerIndex].minus(remainingFillableMakerAmount);

            const extendedOrder = {
                ...order,
                metaData: {
                    ...order.metaData,
                    remainingFillableTakerAmount: remainingFillableTakerAmount,
                }
            }

            return {
                extendedOrder,
                minOfBalancesOrAllowances,
            }
		// If makerAllowance is lower than remainingFillabelMakerAmount, then remainingFillableTakerAmount needs to be reduced
        // e.g., if remainingTakerFillableAmount = 1 and implied remainingTakerFillableAmount = 500 but remainingMakerMinOfBalancesOrAllowances = 100
        // then new remainingTakerFillableAmount = 1 * 100 / 500 = 1/5 = 0 -> gets filtered out from the orderbook automatically
        } else {
            const extendedOrder =  {
                ...order,
                metaData: {
                    ...order.metaData,
                    remainingFillableTakerAmount: new BigNumber(0), // If 
                }
            }

            return {
                extendedOrder,
                minOfBalancesOrAllowances,
            }
        }
    }

    /**
     * A function to get bids and asks from database
     * @param {string} baseToken
     * @param {string} quoteToken 
     * @returns 
     */
    public getSignedOrderEntities = async (baseToken: string, quoteToken: string) => {
        const orderEntities = await this._connection.manager.find(SignedOrderV4Entity, {
            where: {
                takerToken: In([baseToken, quoteToken]),
                makerToken: In([baseToken, quoteToken]),
            },
        });
        const bidSignedOrderEntities = orderEntities.filter(
            (o) => o.takerToken === baseToken && o.makerToken === quoteToken,
        );
        const askSignedOrderEntities = orderEntities.filter(
            (o) => o.takerToken === quoteToken && o.makerToken === baseToken,
        );
        const bidApiOrders: SRAOrder[] = (bidSignedOrderEntities as Required<SignedOrderV4Entity>[])
            .map(orderUtils.deserializeOrderToSRAOrder)
            .filter(orderUtils.isFreshOrder)
            .sort((orderA, orderB) => orderUtils.compareBidOrder(orderA.order, orderB.order));
        const askApiOrders: SRAOrder[] = (askSignedOrderEntities as Required<SignedOrderV4Entity>[])
            .map(orderUtils.deserializeOrderToSRAOrder)
            .filter(orderUtils.isFreshOrder)
            .sort((orderA, orderB) => orderUtils.compareAskOrder(orderA.order, orderB.order));

        return {
            bidApiOrders,
            askApiOrders,
        }
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getOrderBookAsync(
        page: number,
        perPage: number,
        baseToken: string,
        quoteToken: string,
    ): Promise<OrderbookResponse> {
        const {bidApiOrders, askApiOrders} = await this.getSignedOrderEntities(baseToken, quoteToken);

        let makers: string[] = []; // maker address array
        let makerTokens: string[] = []; // maker token address array
    
        // Get maker address array and makerToken address array of bid
        const bidMakerInfo = this.getMakerInfo(bidApiOrders)
        makers = makers.concat(bidMakerInfo.makers);
        makerTokens = makerTokens.concat(bidMakerInfo.makerTokens);

        // Get maker address array and makerToken address array of ask
        const askMakerInfo = this.getMakerInfo(askApiOrders)
        makers = makers.concat(askMakerInfo.makers);
        makerTokens = makerTokens.concat(askMakerInfo.makerTokens);

        // Get minOfBalancesOrAllowances
        let minOfBalancesOrAllowances = await this.getMinOfBalancesOrAllowances(makers, makerTokens);

        const req: OrderbookPriceRequest = {
            page,
            perPage,
            graphUrl: "",
            createdBy: "",
            taker: NULL_ADDRESS,
            feeRecipient: NULL_ADDRESS,
            takerTokenFee: -1,
            threshold: 0,
        }
        const resultBids: SRAOrder[] = [];
        const resultAsks: SRAOrder[] = [];

        bidApiOrders.map((order: SRAOrder) => {
            // Get fillable of bid
            const fillableOrder = this.getFillableOrder(
                makers,
                makerTokens,
                minOfBalancesOrAllowances,
                order
            );

            minOfBalancesOrAllowances = fillableOrder.minOfBalancesOrAllowances;

            // Filtering the bid
            if (this.filterOrder(fillableOrder.extendedOrder, req)) {
                resultBids.push(order);
            }
        });

        askApiOrders.map((order: SRAOrder) => {
            // Get fillable of bid
            const fillableOrder = this.getFillableOrder(
                makers,
                makerTokens,
                minOfBalancesOrAllowances,
                order
            );

            minOfBalancesOrAllowances = fillableOrder.minOfBalancesOrAllowances;

            // Filtering the bid
            if (this.filterOrder(fillableOrder.extendedOrder, req)) {
                resultAsks.push(order);
            }
        });

        const paginatedBidApiOrders = paginationUtils.paginate(resultBids, page, perPage);
        const paginatedAskApiOrders = paginationUtils.paginate(resultAsks, page, perPage);
        return {
            bids: paginatedBidApiOrders,
            asks: paginatedAskApiOrders,
        };
    }

    /**
     * A function to get minOfBalancesOrAllowances using makers and makerTokens
     * @param {string[]} makers // maker address array
     * @param {string[]} makerTokens // makerToken address array
     * @returns {BigNumber[]}
     */
    public getMinOfBalancesOrAllowances = async (
        makers: string[],
        makerTokens: string[]
    ): Promise<BigNumber[]> => {
        // The limit on the length of an array that can be sent as a parameter of smart contract function is 400.
        // Generate makers chunks
        const makersChunks = makers.reduce((resultArray: string[][], item, index) => {
            const batchIndex = Math.floor(index / ARRAY_LIMIT_LENGTH)
            if (!resultArray[batchIndex]) {
                resultArray[batchIndex] = []
            }
            resultArray[batchIndex].push(item);
            return resultArray;
        }, []);

        // Generate maker tokens chunks
        const makersTokensChunks = makerTokens.reduce((resultArray: string[][], item, index) => {
            const batchIndex = Math.floor(index / ARRAY_LIMIT_LENGTH)
            if (!resultArray[batchIndex]) {
                resultArray[batchIndex] = []
            }
            resultArray[batchIndex].push(item);
            return resultArray;
        }, []);

        // Create web3 provider
        const provider = providerUtils.createWeb3Provider(
            defaultHttpServiceConfig.ethereumRpcUrl,
            defaultHttpServiceConfig.rpcRequestTimeout,
            defaultHttpServiceConfig.shouldCompressRequest,
        );

        // Generate the balance checker contract interface
        const balanceCheckerContractInterface = new BalanceCheckerContract(
            BALANCE_CHECKER_ADDRESS,
            provider,
            { gas: BALANCE_CHECKER_GAS_LIMIT }
        );

        // Call the getMinOfBalancesOrAllowances function of balance checker contract
        const checkRes = await Promise.all(makersChunks.map((makersChunk: string[], index: number) => {
            return balanceCheckerContractInterface
                .getMinOfBalancesOrAllowances(makersChunk, makersTokensChunks[index], EXCHANGE_PROXY_ADDRESS)
                .callAsync();
        }));

        let minOfBalancesOrAllowances: BigNumber[] = []; // minOfBalancesOrAllowances of every makers about every makerToken
        checkRes.map((data: BigNumber[]) => {
            minOfBalancesOrAllowances = minOfBalancesOrAllowances.concat(data);
        });

        return minOfBalancesOrAllowances;
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getPricesAsync(req: OrderbookPriceRequest): Promise<any> {
        const result: any[] = [];
        // Get list of pools using Graphql query
        const res = await fetchPoolLists(req.page, req.perPage, req.createdBy, req.graphUrl);
        let pools: any[] = []; // pools list
        res.map((pool: any) => {
            pools.push({
                baseToken: pool.longToken.id,
                quoteToken: pool.collateralToken.id,
            });

            pools.push({
                baseToken: pool.shortToken.id,
                quoteToken: pool.collateralToken.id,
            })
        })

        let makers: string[] = []; // maker address array
        let makerTokens: string[] = []; // maker token address array

        // Get all tokens list
        await Promise.all(pools.map(async (pool) => {
            // Get bid list using pool's baseToken and quoteToken
            const {bidApiOrders, askApiOrders} = await this.getSignedOrderEntities(
                pool.baseToken,
                pool.quoteToken
            );
            // Get ask list using pool's baseToken and quoteToken
            pool.bids = bidApiOrders;
            pool.asks = askApiOrders;

            // Get maker address array and makerToken address array of bid
            const bidMakerInfo = this.getMakerInfo(pool.bids)
            makers = makers.concat(bidMakerInfo.makers);
            makerTokens = makerTokens.concat(bidMakerInfo.makerTokens);

            // Get maker address array and makerToken address array of ask
            const askMakerInfo = this.getMakerInfo(pool.asks)
            makers = makers.concat(askMakerInfo.makers);
            makerTokens = makerTokens.concat(askMakerInfo.makerTokens);
        }));

        let minOfBalancesOrAllowances = await this.getMinOfBalancesOrAllowances(makers, makerTokens);

        // Get best bid and ask
        for (let i = 0; i < pools.length; i++) {
            let bestBid = {}; // best bid
            let count = 0;
            if (pools[i].bids.length !== 0) {
                while(count < pools[i].bids.length) {
                    // Get fillable of bid
                    const fillableOrder = this.getFillableOrder(
                        makers,
                        makerTokens,
                        minOfBalancesOrAllowances,
                        pools[i].bids[count]
                    );

                    minOfBalancesOrAllowances = fillableOrder.minOfBalancesOrAllowances;

                    // Filtering the bid
                    if (this.filterOrder(fillableOrder.extendedOrder, req)) {
                        bestBid = this.getBidOrAskFormat(pools[i].bids[count]);
                        break;
                    }
                    count++;
                }
            }

            let bestAsk = {}; // best ask
            count = 0;
            if (pools[i].asks.length !== 0) {
                while(count < pools[i].asks.length) {
                    // Get fillable of ask
                    const fillableOrder = this.getFillableOrder(
                        makers,
                        makerTokens,
                        minOfBalancesOrAllowances,
                        pools[i].asks[count]
                    );

                    minOfBalancesOrAllowances = fillableOrder.minOfBalancesOrAllowances;

                    // Filtering the ask
                    if (this.filterOrder(fillableOrder.extendedOrder, req)) {
                        bestAsk = this.getBidOrAskFormat(pools[i].asks[count]);
                        break;
                    }
                    count++;
                }
            }

            result.push({
                baseToken: getAddress(pools[i].baseToken), // baseToken of pool
                quoteToken: getAddress(pools[i].quoteToken), // quoteToken of pool
                bid: bestBid, // best bid of pool
                ask: bestAsk, // best ask of pool
            })
        }

        return paginationUtils.paginate(result, 1, req.perPage);
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async getOrdersAsync(
        page: number,
        perPage: number,
        orderFieldFilters: Partial<SignedOrderV4Entity>,
        additionalFilters: { isUnfillable?: boolean; trader?: string },
    ): Promise<PaginatedCollection<SRAOrder>> {
        // Validation
        if (additionalFilters.isUnfillable === true && orderFieldFilters.maker === undefined) {
            throw new ValidationError([
                {
                    field: 'maker',
                    code: ValidationErrorCodes.RequiredField,
                    reason: ValidationErrorReasons.UnfillableRequiresMakerAddress,
                },
            ]);
        }

        // Each array element in `filters` is an OR subclause
        const filters = [];

        // Pre-filters; exists in the entity verbatim
        const columnNames = this._connection.getMetadata(SignedOrderV4Entity).columns.map((x) => x.propertyName);
        const orderFilter = _.pickBy(orderFieldFilters, (v, k) => {
            return columnNames.includes(k);
        });

        // Post-filters; filters that don't exist verbatim
        if (additionalFilters.trader) {
            filters.push({
                ...orderFilter,
                maker: additionalFilters.trader,
            });

            filters.push({
                ...orderFilter,
                taker: additionalFilters.trader,
            });
        } else {
            filters.push(orderFilter);
        }

        // Add an expiry time check to all filters
        const minExpiryTime = Math.floor(Date.now() / ONE_SECOND_MS) + SRA_ORDER_EXPIRATION_BUFFER_SECONDS;
        const filtersWithExpirationCheck = filters.map((filter) => ({
            ...filter,
            expiry: MoreThanOrEqual(minExpiryTime),
        }));

        const [signedOrderCount, signedOrderEntities] = await Promise.all([
            this._connection.manager.count(SignedOrderV4Entity, {
                where: filtersWithExpirationCheck,
            }),
            this._connection.manager.find(SignedOrderV4Entity, {
                where: filtersWithExpirationCheck,
                ...paginationUtils.paginateDBFilters(page, perPage),
                order: {
                    hash: 'ASC',
                },
            }),
        ]);
        const apiOrders = (signedOrderEntities as Required<SignedOrderV4Entity>[]).map(
            orderUtils.deserializeOrderToSRAOrder,
        );

        // Join with persistent orders
        let persistentOrders: SRAOrder[] = [];
        let persistentOrdersCount = 0;
        if (additionalFilters.isUnfillable === true) {
            const removedStates = [
                OrderEventEndState.Cancelled,
                OrderEventEndState.Expired,
                OrderEventEndState.FullyFilled,
                OrderEventEndState.Invalid,
                OrderEventEndState.StoppedWatching,
                OrderEventEndState.Unfunded,
            ];
            const filtersWithoutDuplicateSignedOrders = filters.map((filter) => ({
                ...filter,
                orderState: In(removedStates),
            }));
            let persistentOrderEntities = [];
            [persistentOrdersCount, persistentOrderEntities] = await Promise.all([
                this._connection.manager.count(PersistentSignedOrderV4Entity, {
                    where: filtersWithoutDuplicateSignedOrders,
                }),
                this._connection.manager.find(PersistentSignedOrderV4Entity, {
                    where: filtersWithoutDuplicateSignedOrders,
                    ...paginationUtils.paginateDBFilters(page, perPage),
                    order: {
                        hash: 'ASC',
                    },
                }),
            ]);
            persistentOrders = (persistentOrderEntities as Required<PersistentSignedOrderV4Entity>[]).map(
                orderUtils.deserializeOrderToSRAOrder,
            );
        }

        const allOrders = apiOrders.concat(persistentOrders);
        const total = signedOrderCount + persistentOrdersCount;

        // Paginate
        const paginatedApiOrders = paginationUtils.paginateSerialize(allOrders, total, page, perPage);
        return paginatedApiOrders;
    }
    public async getBatchOrdersAsync(
        page: number,
        perPage: number,
        makerTokens: string[],
        takerTokens: string[],
    ): Promise<PaginatedCollection<SRAOrder>> {
        const filterObject = {
            makerToken: In(makerTokens),
            takerToken: In(takerTokens),
        };
        const signedOrderEntities = (await this._connection.manager.find(SignedOrderV4Entity, {
            where: filterObject,
        })) as Required<SignedOrderV4Entity>[];
        const apiOrders = signedOrderEntities.map(orderUtils.deserializeOrderToSRAOrder);

        // check for expired orders
        const { fresh, expired } = orderUtils.groupByFreshness(apiOrders, SRA_ORDER_EXPIRATION_BUFFER_SECONDS);
        alertOnExpiredOrders(expired);

        const paginatedApiOrders = paginationUtils.paginate(fresh, page, perPage);
        return paginatedApiOrders;
    }
    constructor(connection: Connection, orderWatcher: OrderWatcherInterface) {
        this._connection = connection;
        this._orderWatcher = orderWatcher;
    }
    public async addOrderAsync(signedOrder: SignedLimitOrder): Promise<void> {
        await this._orderWatcher.postOrdersAsync([signedOrder]);
    }
    public async addOrdersAsync(signedOrders: SignedLimitOrder[]): Promise<void> {
        await this._orderWatcher.postOrdersAsync(signedOrders);
    }
    public async addPersistentOrdersAsync(signedOrders: SignedLimitOrder[]): Promise<void> {
        await this._orderWatcher.postOrdersAsync(signedOrders);

        // Figure out which orders were accepted by looking for them in the database.
        const hashes = signedOrders.map((o) => {
            const limitOrder = new LimitOrder(o as LimitOrderFields);
            return limitOrder.getHash();
        });
        const addedOrders = await this._connection.manager.find(SignedOrderV4Entity, {
            where: { hash: In(hashes) },
        });
        // MAX SQL variable size is 999. This limit is imposed via Sqlite.
        // The SELECT query is not entirely effecient and pulls in all attributes
        // so we need to leave space for the attributes on the model represented
        // as SQL variables in the "AS" syntax. We leave 99 free for the
        // signedOrders model
        await this._connection
            .getRepository(PersistentSignedOrderV4Entity)
            .save(addedOrders, { chunk: DB_ORDERS_UPDATE_CHUNK_SIZE });
    }
}
